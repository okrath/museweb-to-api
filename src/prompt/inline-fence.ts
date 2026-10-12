/**
 * Muse sometimes glues a request block's opening fence onto the sentence before it
 * ("Applying all fixes now.```json"). Its page then renders the block as a paragraph, and the
 * Markdown converter escapes the backticks and brackets in it, so no fence starts a line. This
 * finds such blocks: an escaped fence followed by one JSON object, with or without a closing fence.
 */
const escapedFence = "\\`\\`\\`";

export interface InlineFenceBlocks {
  /** Text before the first escaped fence, exactly as received. */
  prefix: string;
  /** Everything from that fence on, with Markdown escapes removed. */
  rest: string;
  /** Each block in `rest`: its range (opening fence to closing fence or object end) and JSON body. */
  blocks: Array<{ start: number; end: number; body: string }>;
}

/**
 * Where the first fence glued onto preceding text starts, escaped or not, or -1. Whatever such a
 * block held may have lost characters on Muse's page (it drops the `\` of `\"`), so it can only
 * be read when its JSON still parses.
 */
export function gluedFenceStart(text: string, from = 0): number {
  const glued = /\\`\\`\\`|[^\s`\\]```/g;
  glued.lastIndex = Math.max(0, from);
  const match = glued.exec(text);
  if (!match) return -1;
  return match[0].startsWith("\\") ? match.index : match.index + 1;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!=~>|])/g, "$1");
}

/** Index just past the JSON object that starts at `start`, or -1 when it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      return index + 1;
    }
  }
  return -1;
}

export function inlineFenceBlocks(markdown: string): InlineFenceBlocks | null {
  const first = markdown.indexOf(escapedFence);
  if (first < 0) return null;
  const rest = unescapeMarkdown(markdown.slice(first));
  const blocks: InlineFenceBlocks["blocks"] = [];
  const opening = /```[\w-]*\s*/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(rest)) !== null) {
    const bodyStart = match.index + match[0].length;
    if (rest[bodyStart] !== "{") continue;
    const bodyEnd = objectEnd(rest, bodyStart);
    if (bodyEnd < 0) break;
    const closing = /^\s*```/.exec(rest.slice(bodyEnd));
    const end = bodyEnd + (closing ? closing[0].length : 0);
    blocks.push({ start: match.index, end, body: rest.slice(bodyStart, bodyEnd) });
    opening.lastIndex = end;
  }
  return blocks.length > 0 ? { prefix: markdown.slice(0, first), rest, blocks } : null;
}
