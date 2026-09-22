import { describe, expect, it } from "vitest";
import { normalizeAnthropic } from "../../src/protocol/normalize-anthropic.js";
import { normalizeOpenAi } from "../../src/protocol/normalize-openai.js";

const base = { headers: {}, requestId: "req_1", clientAbort: new AbortController().signal };
const openAiTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};
const anthropicTool = {
  name: "read_file",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
};

describe("normalizeOpenAi", () => {
  it("folds system and developer messages into one leading system message", () => {
    const req = normalizeOpenAi({
      ...base,
      body: {
        model: "muse",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "developer", content: [{ type: "text", text: "Answer in Vietnamese." }] },
          { role: "user", content: "Hi" },
        ],
        stream: true,
        reasoning_effort: "minimal",
        max_completion_tokens: 200,
        user: "conv-1",
      },
    });
    expect(req.messages).toEqual([
      { role: "system", content: "Be terse.\n\nAnswer in Vietnamese." },
      { role: "user", content: "Hi" },
    ]);
    expect(req.stream).toBe(true);
    expect(req.effort).toBe("low");
    expect(req.maxTokens).toBe(200);
    expect(req.conversationHint).toBe("conv-1");
  });

  it("prefers the x-conversation-id header over the user field", () => {
    const req = normalizeOpenAi({
      ...base,
      headers: { "x-conversation-id": "header-id" },
      body: { model: "muse", messages: [{ role: "user", content: "Hi" }], user: "body-id" },
    });
    expect(req.conversationHint).toBe("header-id");
  });

  it("normalizes tools, assistant calls and tool results", () => {
    const req = normalizeOpenAi({
      ...base,
      body: {
        model: "muse",
        messages: [
          { role: "user", content: "Read it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [openAiTool],
        tool_choice: { type: "function", function: { name: "read_file" } },
      },
    });
    expect(req.tools).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    expect(req.toolChoice).toEqual({ name: "read_file" });
    expect(req.messages).toEqual([
      { role: "user", content: "Read it" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' }] },
      { role: "tool", content: "hello", toolCallId: "call_1" },
    ]);
  });

  it("rejects an unknown tool-call id and invalid tool arguments", () => {
    expect(() =>
      normalizeOpenAi({
        ...base,
        body: { model: "muse", messages: [{ role: "tool", tool_call_id: "missing", content: "x" }] },
      }),
    ).toThrowError(/unknown tool call id/);
    expect(() =>
      normalizeOpenAi({
        ...base,
        body: {
          model: "muse",
          messages: [
            { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "[]" } }] },
          ],
        },
      }),
    ).toThrowError(/JSON object/);
  });

  it("validates tool names and drops tools for tool_choice none", () => {
    expect(() =>
      normalizeOpenAi({
        ...base,
        body: {
          model: "muse",
          messages: [{ role: "user", content: "Hi" }],
          tools: [{ type: "function", function: { name: "bad name", parameters: {} } }],
        },
      }),
    ).toThrowError(/invalid tool name/);
    const req = normalizeOpenAi({
      ...base,
      body: { model: "muse", messages: [{ role: "user", content: "Hi" }], tools: [openAiTool], tool_choice: "none" },
    });
    expect(req.tools).toBeUndefined();
    expect(req.toolChoice).toBe("none");
  });
});

describe("normalizeAnthropic", () => {
  it("maps system, thinking budget and metadata", () => {
    const req = normalizeAnthropic({
      ...base,
      body: {
        model: "muse",
        max_tokens: 512,
        system: [{ type: "text", text: "Be kind." }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
          { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hi!" }] },
          { role: "user", content: "More" },
        ],
        thinking: { type: "enabled", budget_tokens: 20000 },
        metadata: { user_id: "u-1" },
      },
    });
    expect(req.messages).toEqual([
      { role: "system", content: "Be kind." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "More" },
    ]);
    expect(req.effort).toBe("high");
    expect(req.maxTokens).toBe(512);
    expect(req.conversationHint).toBe("u-1");
    expect(req.dialect).toBe("anthropic");
  });

  it("normalizes tools, tool_use and tool_result blocks", () => {
    const req = normalizeAnthropic({
      ...base,
      body: {
        model: "muse",
        tools: [anthropicTool],
        tool_choice: { type: "any" },
        messages: [
          { role: "user", content: "Read it" },
          { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "hello" }], is_error: true }] },
        ],
      },
    });
    expect(req.toolChoice).toBe("required");
    expect(req.tools?.[0]).toEqual({
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(req.messages).toEqual([
      { role: "user", content: "Read it" },
      { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' }] },
      { role: "tool", content: "hello", toolCallId: "tu_1", isError: true },
    ]);
  });

  it("maps named and none choices and rejects an unknown result id", () => {
    const named = normalizeAnthropic({
      ...base,
      body: {
        model: "muse",
        tools: [anthropicTool],
        tool_choice: { type: "tool", name: "read_file" },
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    expect(named.toolChoice).toEqual({ name: "read_file" });
    const none = normalizeAnthropic({
      ...base,
      body: { model: "muse", tools: [anthropicTool], tool_choice: { type: "none" }, messages: [{ role: "user", content: "Hi" }] },
    });
    expect(none.tools).toBeUndefined();
    expect(() =>
      normalizeAnthropic({
        ...base,
        body: { model: "muse", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }] }] },
      }),
    ).toThrowError(/unknown tool call id/);
  });
});
