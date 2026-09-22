import type { TurnEvent } from "../core/types.js";
import { mapTurnError } from "./errors.js";

export interface SerializeOptions {
  requestId: string;
  model: string;
  created?: number;
}

function chunk(opts: SerializeOptions, created: number, delta: Record<string, unknown>, finish: string | null): string {
  return JSON.stringify({
    id: `chatcmpl-${opts.requestId}`,
    object: "chat.completion.chunk",
    created,
    model: opts.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

/** Yields JSON chunk payloads and finally the literal "[DONE]". */
export async function* openAiStreamFrames(
  events: AsyncIterable<TurnEvent>,
  opts: SerializeOptions,
): AsyncGenerator<string> {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let sentRole = false;
  let toolIndex = 0;
  const role = () => {
    sentRole = true;
    return chunk(opts, created, { role: "assistant", content: "" }, null);
  };

  for await (const event of events) {
    if (event.type === "conversation") continue;
    if (event.type === "error") {
      const mapped = mapTurnError(event, "openai");
      if (!sentRole) throw mapped;
      yield JSON.stringify({ error: mapped.body.error });
      yield "[DONE]";
      return;
    }
    if (event.type === "thinking_delta" || event.type === "text_delta") {
      if (!sentRole) yield role();
      yield event.type === "thinking_delta"
        ? chunk(opts, created, { reasoning_content: event.text }, null)
        : chunk(opts, created, { content: event.text }, null);
    } else if (event.type === "tool_call") {
      if (!sentRole) yield role();
      yield chunk(
        opts,
        created,
        {
          tool_calls: [
            {
              index: toolIndex++,
              id: event.id,
              type: "function",
              function: { name: event.name, arguments: event.argumentsJson },
            },
          ],
        },
        null,
      );
    } else if (event.type === "done") {
      if (!sentRole) yield role();
      yield chunk(opts, created, {}, event.stopReason === "tool_use" ? "tool_calls" : "stop");
      yield "[DONE]";
      return;
    }
  }
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason: "stop" | "tool_calls";
  }>;
}

export function serializeOpenAiCompletion(
  events: Iterable<TurnEvent>,
  opts: SerializeOptions,
): OpenAiCompletion | { status: number; body: Record<string, unknown> } {
  let content = "";
  let reasoning = "";
  let stopReason: "end_turn" | "tool_use" | "error" = "end_turn";
  const toolCalls: OpenAiToolCall[] = [];
  for (const event of events) {
    if (event.type === "text_delta") content += event.text;
    else if (event.type === "thinking_delta") reasoning += event.text;
    else if (event.type === "tool_call") {
      toolCalls.push({
        id: event.id,
        type: "function",
        function: { name: event.name, arguments: event.argumentsJson },
      });
    } else if (event.type === "done") stopReason = event.stopReason;
    else if (event.type === "error") {
      const mapped = mapTurnError(event, "openai");
      return { status: mapped.status, body: mapped.body };
    }
  }
  const message: OpenAiCompletion["choices"][0]["message"] = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${opts.requestId}`,
    object: "chat.completion",
    created: opts.created ?? Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 || stopReason === "tool_use" ? "tool_calls" : "stop" }],
  };
}
