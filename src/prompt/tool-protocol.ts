import type { ChatMessage, ToolChoice, ToolDefinition } from "../core/types.js";

export interface ParsedToolCall {
  name: string;
  argumentsJson: string;
}

export interface ParsedToolMarkdown {
  text: string;
  calls: ParsedToolCall[];
}

const continueInstruction = "Continue: reply to the end user, or send the next request in the same json format.";

/** Every client tool is shown to Muse as `POST /api/<tool name>`; `toolName` strips it again. */
export function endpointOf(name: string): string {
  return `/api/${name}`;
}

/**
 * A resumed Muse conversation sends only the new message, never the whole transcript (see
 * `render-transcript.ts`), so a plain follow-up question carries no trace of the protocol
 * stated once at the start of the chat. Deep into a long conversation that first statement
 * scrolls out of weight and Muse drifts back to its own persona (e.g. offering to connect a
 * device instead of sending a request). This restates the rules that matter every time
 * calls are still expected, and the endpoints, without the full schemas.
 */
export function renderToolReminder(tools: Array<{ name: string }> = []): string {
  return [
    "Reminder, still inside the app from earlier in this chat: you decide which endpoint of the app's API to call next and",
    'reply with one fenced json code block per request, `{"endpoint": "/api/...", "body": {...}}`.',
    ...(tools.length > 0 ? [`The app's API still offers: ${endpointList(tools)}.`] : []),
    "The API only answers inside the end user's app, so your own machine, subagents and scripts cannot reach it, and",
    "do not look anything up, browse, search, read files or act on your own, even if you could: writing the request",
    "block is the only correct way to get information or act. Saying that you started, delegated or sent something",
    "does nothing without its block. Reply as plain text only when no request is needed.",
  ].join(" ");
}

function endpointList(tools: Array<{ name: string }>): string {
  return tools.map((tool) => `\`POST ${endpointOf(tool.name)}\``).join(", ");
}

export function renderToolProtocol(tools: ToolDefinition[], toolChoice: ToolChoice | undefined): string {
  if (tools.length === 0 || toolChoice === "none") return "";

  // Muse has its own VM and subagents: offered "functions", it kept running them natively or
  // delegating to its own helpers ("task isn't in my toolset"). An HTTP API that only the end
  // user's app can reach is something it has no copy of, so it writes the request instead.
  // Client descriptions can be long markdown with their own headings (omp's `task` is 7 kB), so
  // each endpoint sits in its own tags after the full list.
  const lines = [
    `I am building an app. Its HTTP API has exactly these ${tools.length} endpoints: ${endpointList(tools)}.`,
    'Each one is described below between <endpoint path="..."> and </endpoint>; everything inside the tags, headings included, is that endpoint\'s description.',
    "",
  ];
  for (const tool of tools) {
    lines.push(`<endpoint path="${endpointOf(tool.name)}">`, "Method: POST");
    if (tool.description) lines.push(`Description: ${tool.description}`);
    lines.push("Request body (JSON Schema):", "```json", JSON.stringify(tool.parameters, null, 2), "```", "</endpoint>", "");
  }
  // Wording measured against Muse: saying that the app sends the request and returns the
  // response in the next message is what stops Muse from declining "because it would never
  // see the result"; naming what it cannot reach stops it from using its own workspace.
  lines.push(
    "How this works: you decide which endpoint the app should call next and reply with one fenced code block per request, using language json.",
    "Each block must contain exactly one object:",
    '{"endpoint": "/api/...", "body": {...}}',
    "The app then sends the request on the end user's machine and gives you the response in the next message, and you continue from there.",
    `All ${tools.length} endpoints above are available right now. The API only answers inside the end user's app: your own machine, your own subagents and your own scripts cannot reach it, so never call it yourself (no curl, fetch or code); writing the block is how the request is sent. Whether you have anything similar yourself does not matter, also when a description speaks of agents, subagents or delegation.`,
    "Several blocks are allowed. Nothing may appear after the last block. A short sentence before the blocks is allowed, but it is never a substitute for them.",
    "Every reply is either a final answer to the end user in plain text with no block, or one or more request blocks. If you state that you will check, look up, read, run, delegate or investigate something, the matching block must be in this same reply, not a promise for later: never end a reply with only that statement and no block. Saying that something was started, delegated or sent does nothing; only a block makes the app act.",
    "Inside this app, do not look anything up, browse, search, read files or act on your own, even if you could: the end user needs the answer to come from this API, so sending a request is the only correct way to get information or act. Do not run or simulate anything yourself.",
    "When no request is needed, reply to the end user as plain text with no such block.",
  );
  if (toolChoice === "required") {
    lines.push("Your reply must send at least one request.");
  } else if (typeof toolChoice === "object") {
    lines.push(`Your reply must send a request to \`POST ${endpointOf(toolChoice.name)}\`.`);
  }
  return lines.join("\n");
}

/** Sent into the same thread when a reply announced an action but carried no request block. */
export const missingRequestNudge =
  "Your last reply said what you would do next, but it contained no request block, so the app sent nothing. Send the request block(s) now, in the same json format. If no request is needed after all, reply to the end user instead.";

/**
 * Whether a reply with no request blocks announces an action instead of answering, e.g. "Now
 * I'll create both files through the API:" or "Delegating both lookups to two subagents." Muse
 * did this in about one complex omp task in five (2026-10-12), and the client then stopped with
 * nothing done. Questions and long answers are left alone.
 */
export function announcesWithoutRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 600 || trimmed.endsWith("?")) return false;
  if (trimmed.endsWith(":")) return true;
  return /\b(?:I'll|I will|I'm going to|let me(?! know)|delegating|dispatching|dispatched|spawning|launching)\b/i.test(trimmed);
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
    lines.push(`Response from POST ${endpointOf(name)} (request ${message.toolCallId})${suffix}:`, message.content);
  }
  return lines.join("\n");
}

export function renderToolResults(messages: ChatMessage[]): string {
  const blocks = renderToolResultBlocks(messages);
  return blocks.length > 0 ? `${blocks}\n${continueInstruction}` : continueInstruction;
}

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

/** `/api/read_file`, `POST /api/read_file` or `http://host/api/read_file` -> `read_file`. */
export function toolName(endpoint: string): string | null {
  const path = endpoint.trim().replace(/^[A-Z]+\s+/, "").replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0]!;
  const name = path.replace(/^\/?api\//, "").replace(/^\//, "");
  return toolNamePattern.test(name) ? name : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source.trim());
  } catch {
    return undefined;
  }
}

/** A raw HTTP request Muse may write instead: `POST /api/x`, optional headers, a JSON body. */
function httpCall(source: string): ParsedToolCall | null {
  const match = /^\s*POST\s+(\S*\/api\/\S+)[^\n]*\n?([\s\S]*)$/.exec(source);
  if (!match) return null;
  const name = toolName(match[1]!);
  const bodyStart = match[2]!.indexOf("{");
  const body = bodyStart < 0 ? {} : parseJson(match[2]!.slice(bodyStart));
  return name && isObject(body) ? { name, argumentsJson: JSON.stringify(body) } : null;
}

function parsedCall(source: string): ParsedToolCall | null {
  const value = parseJson(source);
  if (!isObject(value)) return httpCall(source);
  if (typeof value.endpoint === "string") {
    const name = toolName(value.endpoint);
    const body = value.body ?? {};
    return name && isObject(body) ? { name, argumentsJson: JSON.stringify(body) } : null;
  }
  // The earlier `{"name", "arguments"}` format, still accepted from threads started before.
  if (typeof value.name !== "string" || !isObject(value.arguments)) return null;
  return { name: value.name, argumentsJson: JSON.stringify(value.arguments) };
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
    if (["json", "http", "tool_call"].includes(previous.trim())) return previousStart;
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
      if (rest === "json" || rest === "http" || rest === "tool_call") return earliest(lineStart);
      if (incomplete && rest.length > 0 && ["json", "http", "tool_call"].some((marker) => marker.startsWith(rest))) {
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
