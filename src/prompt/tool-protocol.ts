import type { ChatMessage, ToolChoice, ToolDefinition } from "../core/types.js";

export interface ParsedToolCall {
  name: string;
  argumentsJson: string;
}

export interface ParsedToolMarkdown {
  text: string;
  calls: ParsedToolCall[];
}

const continueInstruction = "Continue: reply to the end user, or request the next function in the same json format.";

export function renderToolProtocol(tools: ToolDefinition[], toolChoice: ToolChoice | undefined): string {
  if (tools.length === 0 || toolChoice === "none") return "";

  const lines = [
    "I am building a program. Here are the functions the program can run:",
    "",
  ];
  for (const tool of tools) {
    lines.push(`${tool.name}(arguments schema)`);
    if (tool.description) lines.push(`Description: ${tool.description}`);
    lines.push("JSON Schema:", "```json", JSON.stringify(tool.parameters, null, 2), "```", "");
  }
  // Wording measured against Muse: saying that the program runs the function and sends the
  // result back in the next message is what stops Muse from declining "because it would never
  // see the result"; naming what it cannot do itself stops it from using its own workspace.
  lines.push(
    "How this works: you decide which function the program should run next and reply with one fenced code block per function call, using language json.",
    "Each block must contain exactly one object:",
    '{"name": "...", "arguments": {...}}',
    "The program then runs the function and sends you its result in the next message, and you continue from there.",
    "Several blocks are allowed. Nothing may appear after the last block. A short sentence before the blocks is allowed, but it is never a substitute for them.",
    "Every reply is either a final answer to the end user in plain text with no block, or one or more function-call blocks. If you state that you will check, look up, read, run or investigate something, the matching block must be in this same reply, not a promise for later: never end a reply with only that statement and no block.",
    "Inside this program, do not look anything up, browse, search, read files or act on your own, even if you could: the end user needs the answer to come from these functions, so requesting a function is the only correct way to get information or act. Do not run or simulate anything yourself.",
    "When no function is needed, reply to the end user as plain text with no such block.",
  );
  if (toolChoice === "required") {
    lines.push("Your reply must request at least one function.");
  } else if (typeof toolChoice === "object") {
    lines.push(`Your reply must request the function \`${toolChoice.name}\`.`);
  }
  return lines.join("\n");
}

export function renderToolResultBlocks(messages: ChatMessage[], context: ChatMessage[] = messages): string {
  const names = new Map<string, string>();
  for (const message of context) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }

  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue;
    const name = names.get(message.toolCallId) ?? "unknown";
    const suffix = message.isError ? " (error)" : "";
    lines.push(`Function result of ${name} (call ${message.toolCallId})${suffix}:`, message.content);
  }
  return lines.join("\n");
}

export function renderToolResults(messages: ChatMessage[]): string {
  const blocks = renderToolResultBlocks(messages);
  return blocks.length > 0 ? `${blocks}\n${continueInstruction}` : continueInstruction;
}

function parsedCall(source: string): ParsedToolCall | null {
  let value: unknown;
  try {
    value = JSON.parse(source.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.arguments !== "object" || record.arguments === null || Array.isArray(record.arguments)) {
    return null;
  }
  return { name: record.name, argumentsJson: JSON.stringify(record.arguments) };
}

interface Candidate {
  start: number;
  end: number;
  kind: "fence" | "tag";
  call: ParsedToolCall;
}

interface Span {
  start: number;
  end: number;
}

function closingFence(markdown: string, bodyStart: number, minimumLength: number): { start: number; end: number } | null {
  let lineStart = bodyStart;
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");
    const rest = line.replace(/^[ \t]*/, "");
    const ticks = rest.match(/^`+/)?.[0].length ?? 0;
    if (ticks >= minimumLength && /^`+[ \t]*$/.test(rest)) {
      return { start: lineStart, end: newline === -1 ? lineEnd : newline + 1 };
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return null;
}

function fenceCandidates(markdown: string): { candidates: Candidate[]; spans: Span[] } {
  const candidates: Candidate[] = [];
  const spans: Span[] = [];
  const opening = /^[ \t]{0,3}(`{3,})[^\r\n]*(?:\r?\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(markdown)) !== null) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    const closing = closingFence(markdown, bodyStart, match[1]!.length);
    if (!closing) {
      spans.push({ start, end: markdown.length });
      break;
    }
    spans.push({ start, end: closing.end });
    const call = parsedCall(markdown.slice(bodyStart, closing.start));
    if (call) candidates.push({ start, end: closing.end, kind: "fence", call });
    opening.lastIndex = closing.end;
  }
  return { candidates, spans };
}

function insideSpan(index: number, spans: Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function tagCandidates(markdown: string, spans: Span[]): Candidate[] {
  const candidates: Candidate[] = [];
  const tags = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(markdown)) !== null) {
    if (insideSpan(match.index, spans)) continue;
    const call = parsedCall(match[1]!);
    if (call) candidates.push({ start: match.index, end: match.index + match[0].length, kind: "tag", call });
  }
  return candidates;
}

function markerLineStart(markdown: string, candidate: Candidate): number {
  if (candidate.kind !== "fence" || candidate.start === 0 || markdown[candidate.start - 1] !== "\n") {
    return candidate.start;
  }
  let previousEnd = candidate.start - 1;
  while (previousEnd > 0 || markdown[previousEnd] !== undefined) {
    const previousStart = markdown.lastIndexOf("\n", previousEnd - 1) + 1;
    const previous = markdown.slice(previousStart, previousEnd).replace(/\r$/, "");
    if (previous.trim() === "json" || previous.trim() === "tool_call") return previousStart;
    if (previous.trim().length > 0 || previousStart === 0) break;
    previousEnd = previousStart - 1;
  }
  return candidate.start;
}

export function parseToolCalls(markdown: string): ParsedToolMarkdown {
  const fenced = fenceCandidates(markdown);
  const candidates = [...fenced.candidates, ...tagCandidates(markdown, fenced.spans)].sort((a, b) => a.start - b.start);
  const selected: Candidate[] = [];
  let previousEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < previousEnd) continue;
    selected.push(candidate);
    previousEnd = candidate.end;
  }

  const text: string[] = [];
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  for (const candidate of selected) {
    const removeStart = markerLineStart(markdown, candidate);
    text.push(markdown.slice(cursor, removeStart));
    cursor = candidate.end;
    calls.push(candidate.call);
  }
  text.push(markdown.slice(cursor));
  return { text: text.join("").trim(), calls };
}

function possibleBlockStart(markdown: string, from: number): number | null {
  const tag = "<tool_call>";
  let tagStart = markdown.indexOf(tag, from);
  for (let length = tag.length - 1; length > 0; length--) {
    if (markdown.endsWith(tag.slice(0, length))) {
      const start = markdown.length - length;
      if (start >= from) tagStart = tagStart < 0 ? start : Math.min(tagStart, start);
    }
  }
  const earliest = (lineStart: number) => (tagStart >= 0 && tagStart < lineStart ? tagStart : lineStart);

  let lineStart = 0;
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    if (lineStart >= from) {
      const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");
      const rest = line.replace(/^[ \t]*/, "");
      const incomplete = newline === -1;
      if (/^```/.test(rest) || (incomplete && /^`{1,2}$/.test(rest))) return earliest(lineStart);
      if (rest.startsWith("<tool_call>") || (incomplete && rest.length > 0 && "<tool_call>".startsWith(rest))) {
        return earliest(lineStart);
      }
      if (rest === "json" || rest === "tool_call") return earliest(lineStart);
      if (incomplete && rest.length > 0 && ("json".startsWith(rest) || "tool_call".startsWith(rest))) {
        return earliest(lineStart);
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return tagStart;
}

export interface ToolTextFilter {
  append(markdownDelta: string): string;
  finish(): ParsedToolMarkdown & { unsentText: string };
}

/** Holds a possible fenced call from the first marker without leaking it to a stream. */
export function createToolTextFilter(): ToolTextFilter {
  let markdown = "";
  let forwardedLength = 0;
  let forwardedText = "";

  return {
    append(markdownDelta) {
      markdown += markdownDelta;
      const start = possibleBlockStart(markdown, forwardedLength);
      const safeEnd = start ?? markdown.length;
      const safe = markdown.slice(forwardedLength, safeEnd);
      forwardedLength = safeEnd;
      forwardedText += safe;
      return safe;
    },
    finish() {
      const parsed = parseToolCalls(markdown);
      const unsentText = parsed.text.startsWith(forwardedText) ? parsed.text.slice(forwardedText.length) : forwardedText.length === 0 ? parsed.text : "";
      return { ...parsed, unsentText };
    },
  };
}
