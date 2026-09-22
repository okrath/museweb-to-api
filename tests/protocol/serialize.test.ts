import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../../src/core/types.js";
import { anthropicStreamFrames, serializeAnthropicMessage } from "../../src/protocol/serialize-anthropic.js";
import { openAiStreamFrames, serializeOpenAiCompletion } from "../../src/protocol/serialize-openai.js";

async function* stream(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
  for (const event of events) yield event;
}

const okEvents: TurnEvent[] = [
  { type: "text_delta", text: "Hello " },
  { type: "text_delta", text: "world" },
  { type: "conversation", conversationId: "https://muse.ai/c/1" },
  { type: "done", stopReason: "end_turn" },
];

const opts = { requestId: "abc", model: "muse", created: 1 };

describe("OpenAI serialization", () => {
  it("streams role, content deltas, stop and [DONE]", async () => {
    const frames: string[] = [];
    for await (const frame of openAiStreamFrames(stream(okEvents), opts)) frames.push(frame);
    expect(frames.at(-1)).toBe("[DONE]");
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f));
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(parsed.map((p) => p.choices[0].delta.content ?? "").join("")).toBe("Hello world");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("throws a mapped error when the turn fails before any content", async () => {
    const failing = stream([
      { type: "error", kind: "auth", message: "not signed in" },
      { type: "done", stopReason: "error" },
    ]);
    await expect(async () => {
      for await (const _frame of openAiStreamFrames(failing, opts)) {
        /* drain */
      }
    }).rejects.toMatchObject({ status: 502 });
  });

  it("builds a non-streaming completion", () => {
    const body = serializeOpenAiCompletion(okEvents, opts);
    expect(body).toMatchObject({
      id: "chatcmpl-abc",
      object: "chat.completion",
      model: "muse",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
    });
  });

  it("maps rate limits to 429 in non-streaming mode", () => {
    const body = serializeOpenAiCompletion(
      [{ type: "error", kind: "rate_limit", message: "limit", retryAfterSec: 60 }, { type: "done", stopReason: "error" }],
      opts,
    );
    expect(body).toMatchObject({ status: 429 });
  });

  it("serializes tool calls in streaming and non-streaming form", async () => {
    const events: TurnEvent[] = [
      { type: "tool_call", id: "call_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' },
      { type: "done", stopReason: "tool_use" },
    ];
    const frames: string[] = [];
    for await (const frame of openAiStreamFrames(stream(events), opts)) frames.push(frame);
    const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    expect(parsed[1].choices[0].delta.tool_calls).toEqual([
      { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
    ]);
    expect(parsed.at(-1).choices[0].finish_reason).toBe("tool_calls");

    const body = serializeOpenAiCompletion(events, opts);
    expect(body).toMatchObject({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  });
});

describe("Anthropic serialization", () => {
  it("streams message_start, one text block and message_stop", async () => {
    const frames: Array<{ event: string; data: unknown }> = [];
    for await (const frame of anthropicStreamFrames(stream(okEvents), opts)) frames.push(frame);
    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("builds a non-streaming message with text content", () => {
    const body = serializeAnthropicMessage(okEvents, opts);
    expect(body).toMatchObject({
      id: "msg_abc",
      type: "message",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
    });
  });

  it("serializes tool_use blocks with parsed input", async () => {
    const events: TurnEvent[] = [
      { type: "tool_call", id: "tu_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' },
      { type: "done", stopReason: "tool_use" },
    ];
    const frames: Array<{ event: string; data: any }> = [];
    for await (const frame of anthropicStreamFrames(stream(events), opts)) frames.push(frame);
    expect(frames.find((frame) => frame.event === "content_block_start")?.data.content_block).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "read_file",
      input: {},
    });
    expect(frames.find((frame) => frame.event === "content_block_delta")?.data.delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"path":"a.txt"}',
    });
    expect(frames.find((frame) => frame.event === "message_delta")?.data.delta.stop_reason).toBe("tool_use");

    const body = serializeAnthropicMessage(events, opts);
    expect(body).toMatchObject({
      content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } }],
      stop_reason: "tool_use",
    });
  });
});
