import { z } from "zod";
import type { ChatMessage, ChatRequest, Effort, ToolChoice, ToolDefinition } from "../core/types.js";
import { ProtocolError } from "./errors.js";
import type { NormalizeInput } from "./normalize-openai.js";

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });
const blockSchema = z.object({ type: z.string() }).passthrough();
const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()),
});
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string(),
  input: z.record(z.unknown()),
});
const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(textPartSchema)]).optional(),
  is_error: z.boolean().optional(),
});
const toolChoiceSchema = z.union([
  z.enum(["auto", "any", "none"]),
  z.object({ type: z.enum(["auto", "any", "none"]) }),
  z.object({ type: z.literal("tool"), name: z.string() }),
]);

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(blockSchema)]),
});

const bodySchema = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  system: z.union([z.string(), z.array(textPartSchema)]).optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  thinking: z
    .union([
      z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().positive() }),
      z.object({ type: z.literal("disabled") }),
    ])
    .optional(),
  metadata: z.object({ user_id: z.string().optional() }).optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
});

function invalid(message: string): never {
  throw new ProtocolError(400, "anthropic", "invalid_request_error", message);
}

function validateToolName(name: string): string {
  if (!toolNamePattern.test(name)) invalid(`invalid tool name "${name}"`);
  return name;
}

function textBlocks(content: string | Array<{ type: string }>): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      const parsed = textPartSchema.safeParse(block);
      if (!parsed.success) invalid("only text content is supported");
      return parsed.data.text;
    })
    .join("");
}

function toolResultContent(content: string | Array<{ type: string }> | undefined): string {
  return content === undefined ? "" : textBlocks(content);
}

function normalizeTools(raw: z.infer<typeof bodySchema>["tools"]): ToolDefinition[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tool) => ({
    name: validateToolName(tool.name),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: tool.input_schema,
  }));
}

function normalizeToolChoice(raw: z.infer<typeof bodySchema>["tool_choice"]): ToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    if (raw === "any") return "required";
    return raw;
  }
  if (raw.type === "any") return "required";
  if (raw.type === "tool") return { name: validateToolName(raw.name) };
  return raw.type;
}

function normalizeMessages(raw: z.infer<typeof bodySchema>["messages"]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const seenToolCallIds = new Set<string>();

  for (const msg of raw) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const text: string[] = [];
      const toolCalls: NonNullable<ChatMessage["toolCalls"]> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          text.push(textBlocks([block]));
          continue;
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") continue;
        if (block.type !== "tool_use") invalid("only text content is supported");
        const parsed = toolUseBlockSchema.safeParse(block);
        if (!parsed.success) invalid("invalid tool_use block");
        if (seenToolCallIds.has(parsed.data.id)) invalid(`duplicate tool call id "${parsed.data.id}"`);
        const name = validateToolName(parsed.data.name);
        seenToolCallIds.add(parsed.data.id);
        toolCalls.push({ id: parsed.data.id, name, argumentsJson: JSON.stringify(parsed.data.input) });
      }
      const normalized: ChatMessage = { role: "assistant", content: text.join("") };
      if (toolCalls.length > 0) normalized.toolCalls = toolCalls;
      messages.push(normalized);
      continue;
    }

    let text: string[] = [];
    let emittedMessage = false;
    const flushText = () => {
      if (text.length === 0) return;
      messages.push({ role: "user", content: text.join("") });
      text = [];
      emittedMessage = true;
    };

    for (const block of msg.content) {
      if (block.type === "text") {
        text.push(textBlocks([block]));
        continue;
      }
      if (block.type !== "tool_result") invalid("only text content is supported");
      const parsed = toolResultBlockSchema.safeParse(block);
      if (!parsed.success) invalid("invalid tool_result block");
      if (!seenToolCallIds.has(parsed.data.tool_use_id)) {
        invalid(`tool_result references unknown tool call id "${parsed.data.tool_use_id}"`);
      }
      flushText();
      messages.push({
        role: "tool",
        content: toolResultContent(parsed.data.content),
        toolCallId: parsed.data.tool_use_id,
        ...(parsed.data.is_error === undefined ? {} : { isError: parsed.data.is_error }),
      });
      emittedMessage = true;
    }
    flushText();
    if (!emittedMessage) messages.push({ role: "user", content: "" });
  }

  return messages;
}

function effortFromThinking(thinking: z.infer<typeof bodySchema>["thinking"]): Effort | undefined {
  if (thinking === undefined) return undefined;
  if (thinking.type === "disabled") return "none";
  if (thinking.budget_tokens <= 2048) return "low";
  if (thinking.budget_tokens <= 8192) return "medium";
  if (thinking.budget_tokens <= 32_000) return "high";
  return "xhigh";
}

export function normalizeAnthropic(input: NormalizeInput): ChatRequest {
  const parsed = bodySchema.safeParse(input.body);
  if (!parsed.success) {
    const message =
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") ||
      "Invalid request body";
    throw new ProtocolError(400, "anthropic", "invalid_request_error", message);
  }
  const body = parsed.data;
  const normalizedTools = normalizeTools(body.tools);
  const requestedToolChoice = normalizeToolChoice(body.tool_choice);
  const toolChoice = requestedToolChoice ?? (normalizedTools ? "auto" : undefined);
  const tools = toolChoice === "none" ? undefined : normalizedTools;

  const messages: ChatMessage[] = [];
  const system = body.system === undefined ? "" : typeof body.system === "string" ? body.system : body.system.map((p) => p.text).join("");
  if (system.length > 0) messages.push({ role: "system", content: system });
  messages.push(...normalizeMessages(body.messages));

  const header = input.headers["x-conversation-id"];
  const conversationHint = (typeof header === "string" ? header : undefined) ?? body.metadata?.user_id;

  return {
    requestId: input.requestId,
    dialect: "anthropic",
    model: body.model,
    messages,
    stream: body.stream ?? false,
    effort: effortFromThinking(body.thinking),
    maxTokens: body.max_tokens,
    conversationHint,
    tools,
    toolChoice,
    clientAbort: input.clientAbort,
  };
}
