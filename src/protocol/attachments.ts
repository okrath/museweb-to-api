import type { Attachment } from "../core/types.js";

/** Media types muse.ai attachments are expected to use; anything else falls back to `.bin`. */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/mpeg": "mpeg",
  "video/x-msvideo": "avi",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
};

const DATA_URL_PATTERN = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([a-zA-Z0-9+/]+=*)$/;
const BASE64_PATTERN = /^[a-zA-Z0-9+/]+=*$/;

function extensionFor(mediaType: string): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()] ?? "bin";
}

/** Parses an inline `data:<mime>;base64,<data>` URL; remote URLs are rejected via `fail`. */
export function attachmentFromDataUrl(url: string, filenameHint: string | undefined, fail: (message: string) => never): Attachment {
  const match = DATA_URL_PATTERN.exec(url);
  if (!match) fail("attachment url must be an inline base64 data: URL (remote URLs are not supported)");
  const [, mediaType, data] = match as unknown as [string, string, string];
  return attachmentFromBase64(mediaType, data, filenameHint, fail);
}

export function attachmentFromBase64(mediaType: string, data: string, filenameHint: string | undefined, fail: (message: string) => never): Attachment {
  if (data.length === 0 || !BASE64_PATTERN.test(data)) fail("attachment data must be non-empty base64");
  const type = mediaType.toLowerCase();
  return { filename: filenameHint ?? `attachment.${extensionFor(type)}`, mediaType: type, data };
}
