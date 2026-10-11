import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ChatRequest } from "../core/types.js";

/** Anything that may carry a credential never reaches the log. */
const CREDENTIAL_HEADER = /auth|token|key|secret|cookie|password/i;
/** Transport headers say nothing about which agent sent the request. */
const SKIPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-type",
  "accept",
  "accept-encoding",
  "accept-language",
]);
const HEADER_VALUE_MAX = 120;
const SYSTEM_HEAD_MAX = 100;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * What distinguishes one client agent from another without logging whole prompts: the client
 * headers, short hashes of the system prompt, tool set, conversation hint and first user message,
 * and the opening of the system prompt.
 */
export function trafficSummary(headers: IncomingHttpHeaders, req: ChatRequest): Record<string, unknown> {
  const clientHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || SKIPPED_HEADERS.has(name) || CREDENTIAL_HEADER.test(name)) continue;
    clientHeaders[name] = (Array.isArray(value) ? value.join(", ") : value).slice(0, HEADER_VALUE_MAX);
  }
  const system = req.messages.find((message) => message.role === "system")?.content ?? "";
  const firstUser = req.messages.find((message) => message.role === "user")?.content ?? "";
  const toolNames = (req.tools ?? []).map((tool) => tool.name).sort();
  return {
    requestId: req.requestId,
    dialect: req.dialect,
    model: req.model,
    stream: req.stream,
    messages: req.messages.length,
    hintHash: req.conversationHint === undefined ? null : shortHash(req.conversationHint),
    systemHash: system ? shortHash(system) : null,
    systemChars: system.length,
    systemHead: system.slice(0, SYSTEM_HEAD_MAX).replace(/\s+/g, " "),
    firstUserHash: firstUser ? shortHash(firstUser) : null,
    toolsHash: toolNames.length > 0 ? shortHash(toolNames.join(",")) : null,
    toolCount: toolNames.length,
    toolNames,
    headers: clientHeaders,
  };
}
