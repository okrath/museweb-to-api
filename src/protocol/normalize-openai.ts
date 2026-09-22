import { z } from "zod";
import type { ChatMessage, ChatRequest, Effort, ToolChoice, ToolDefinition } from "../core/types.js";
import { ProtocolError } from "./errors.js";

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const contentPartSchema = z.object({ type: z.string() }).passthrough();
const toolDefinitionSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  }),
});
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
]);

const messageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.enum(["system", "developer", "user"]),
    content: z.union([z.string(), z.array(contentPartSchema)]),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1),
    content: z.union([z.string(), z.array(contentPartSchema)]),
  }),
]);

const bodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  reasoning_effort: z.enum(["minimal", "none", "low", "medium", "high", "xhigh"]).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  user: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  functions: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

type RawContent = string | Array<{ type: string }> | null | undefined;

function invalid(message: string): never {
  throw new ProtocolError(400, "openai", "invalid_request_error", message);
}

function validateToolName(name: string): string {
  if (!toolNamePattern.test(name)) invalid(`invalid tool name "${name}"`);
  return name;
}

function textContent(content: RawContent): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      const parsed = textPartSchema.safeParse(part);
      if (!parsed.success) invalid("only text content is supported");
      return parsed.data.text;
    })
    .join("");
}

function validateArguments(name: string, argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    invalid(`arguments for tool call "${name}" must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid(`arguments for tool call "${name}" must be a JSON object`);
  }
  return argumentsJson;
}

function normalizeTools(raw: z.infer<typeof bodySchema>["tools"]): ToolDefinition[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map(({ function: fn }) => ({
    name: validateToolName(fn.name),
    ...(fn.description === undefined ? {} : { description: fn.description }),
    parameters: fn.parameters,
  }));
}

function normalizeToolChoice(raw: z.infer<typeof bodySchema>["tool_choice"]): ToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  return { name: validateToolName(raw.function.name) };
}

function normalizeMessages(raw: z.infer<typeof bodySchema>["messages"]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  const seenToolCallIds = new Set<string>();

  for (const msg of raw) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(textContent(msg.content));
      continue;
    }
    if (msg.role === "assistant") {
      const toolCalls = msg.tool_calls?.map((call) => {
        if (seenToolCallIds.has(call.id)) invalid(`duplicate tool call id "${call.id}"`);
        const name = validateToolName(call.function.name);
        const argumentsJson = validateArguments(name, call.function.arguments);
        seenToolCallIds.add(call.id);
        return { id: call.id, name, argumentsJson };
      });
      const normalized: ChatMessage = { role: "assistant", content: textContent(msg.content ?? null) };
      if (toolCalls && toolCalls.length > 0) normalized.toolCalls = toolCalls;
      rest.push(normalized);
      continue;
    }
    if (msg.role === "user") {
      rest.push({ role: "user", content: textContent(msg.content) });
      continue;
    }
    if (msg.role !== "tool") invalid("unsupported message role");
    if (!seenToolCallIds.has(msg.tool_call_id)) {
      invalid(`tool message references unknown tool call id "${msg.tool_call_id}"`);
    }
    rest.push({ role: "tool", content: textContent(msg.content), toolCallId: msg.tool_call_id });
  }

  if (systemParts.length === 0) return rest;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

function mapEffort(raw: z.infer<typeof bodySchema>["reasoning_effort"]): Effort | undefined {
  if (raw === undefined) return undefined;
  return raw === "minimal" ? "low" : raw;
}

export interface NormalizeInput {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  requestId: string;
  clientAbort: AbortSignal;
}

export function normalizeOpenAi(input: NormalizeInput): ChatRequest {
  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success) {
    const message =
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") ||
      "Invalid request body";
    throw new ProtocolError(400, "openai", "invalid_request_error", message);
  }
  const body = parsed.data;
  if (body.functions !== undefined || body.response_format !== undefined) {
    throw new ProtocolError(400, "openai", "invalid_request_error", "functions and response_format are not supported");
  }

  const normalizedTools = normalizeTools(body.tools);
  const requestedToolChoice = normalizeToolChoice(body.tool_choice);
  const toolChoice = requestedToolChoice ?? (normalizedTools ? "auto" : undefined);
  const tools = toolChoice === "none" ? undefined : normalizedTools;

  const header = input.headers["x-conversation-id"];
  const conversationHint = (typeof header === "string" ? header : undefined) ?? body.user;

  return {
    requestId: input.requestId,
    dialect: "openai",
    model: body.model,
    messages: normalizeMessages(body.messages),
    stream: body.stream ?? false,
    effort: mapEffort(body.reasoning_effort),
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    conversationHint,
    tools,
    toolChoice,
    clientAbort: input.clientAbort,
  };
}

export function openAiIncludeUsage(body: unknown): boolean {
  const parsed = bodySchema.safeParse(body);
  return parsed.success && parsed.data.stream_options?.include_usage === true;
}
