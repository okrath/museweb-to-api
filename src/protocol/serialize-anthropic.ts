import type { TurnEvent } from "../core/types.js";
import { mapTurnError } from "./errors.js";
import type { SerializeOptions } from "./serialize-openai.js";

export interface AnthropicStreamFrame {
  event: string;
  data: unknown;
}

type BlockKind = "thinking" | "text" | "tool_use";

const zeroUsage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };

export async function* anthropicStreamFrames(
  events: AsyncIterable<TurnEvent>,
  opts: SerializeOptions,
): AsyncGenerator<AnthropicStreamFrame> {
  let started = false;
  let blockIndex = -1;
  let openBlock: BlockKind | null = null;
  let stopReason: "end_turn" | "tool_use" = "end_turn";

  const messageStart = (): AnthropicStreamFrame => {
    started = true;
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${opts.requestId}`,
          type: "message",
          role: "assistant",
          model: opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    };
  };

  const closeBlock = function* (): Generator<AnthropicStreamFrame> {
    if (openBlock === null) return;
    yield { event: "content_block_stop", data: { type: "content_block_stop", index: blockIndex } };
    openBlock = null;
  };

  const openBlockOfKind = function* (
    kind: BlockKind,
    call?: Extract<TurnEvent, { type: "tool_call" }>,
  ): Generator<AnthropicStreamFrame> {
    yield* closeBlock();
    blockIndex++;
    openBlock = kind;
    const contentBlock =
      kind === "thinking"
        ? { type: "thinking", thinking: "" }
        : kind === "text"
          ? { type: "text", text: "" }
          : { type: "tool_use", id: call!.id, name: call!.name, input: {} };
    yield {
      event: "content_block_start",
      data: { type: "content_block_start", index: blockIndex, content_block: contentBlock },
    };
  };

  for await (const event of events) {
    if (event.type === "conversation") continue;
    if (event.type === "error") {
      const mapped = mapTurnError(event, "anthropic");
      if (!started) throw mapped;
      yield { event: "error", data: mapped.body };
      return;
    }
    if (event.type === "thinking_delta" || event.type === "text_delta") {
      if (!started) yield messageStart();
      const kind: BlockKind = event.type === "thinking_delta" ? "thinking" : "text";
      if (openBlock !== kind) yield* openBlockOfKind(kind);
      yield {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: blockIndex,
          delta: kind === "thinking" ? { type: "thinking_delta", thinking: event.text } : { type: "text_delta", text: event.text },
        },
      };
    } else if (event.type === "tool_call") {
      if (!started) yield messageStart();
      stopReason = "tool_use";
      yield* openBlockOfKind("tool_use", event);
      yield {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: event.argumentsJson },
        },
      };
    } else if (event.type === "done") {
      if (!started) yield messageStart();
      if (event.stopReason === "tool_use") stopReason = "tool_use";
    }
  }

  if (!started) return;
  yield* closeBlock();
  yield {
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: zeroUsage },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

export type AnthropicContentBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use";
  stop_sequence: null;
  usage: typeof zeroUsage;
}

function parseInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // The router only creates tool events from parsed objects; keep serialization defensive.
  }
  return {};
}

export function serializeAnthropicMessage(
  events: Iterable<TurnEvent>,
  opts: SerializeOptions,
): AnthropicMessage | { status: number; body: Record<string, unknown> } {
  let thinking = "";
  let text = "";
  let stopReason: "end_turn" | "tool_use" = "end_turn";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const event of events) {
    if (event.type === "thinking_delta") thinking += event.text;
    else if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call") {
      toolCalls.push({ id: event.id, name: event.name, input: parseInput(event.argumentsJson) });
    } else if (event.type === "done") {
      if (event.stopReason === "tool_use") stopReason = "tool_use";
    } else if (event.type === "error") {
      const mapped = mapTurnError(event, "anthropic");
      return { status: mapped.status, body: mapped.body };
    }
  }
  if (toolCalls.length > 0) stopReason = "tool_use";
  const content: AnthropicContentBlock[] = [];
  if (thinking.length > 0) content.push({ type: "thinking", thinking });
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: `msg_${opts.requestId}`,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: zeroUsage,
  };
}
