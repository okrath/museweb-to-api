import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/types.js";
import { createToolTextFilter, parseToolCalls, renderToolProtocol, renderToolResults } from "../../src/prompt/tool-protocol.js";

const tools = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("tool prompt protocol", () => {
  it("renders every function, schema and choice contract without forbidden framing", () => {
    const prompt = renderToolProtocol(tools, "required");
    expect(prompt).toContain("read_file(arguments schema)");
    expect(prompt).toContain("write_file(arguments schema)");
    expect(prompt).toContain("JSON Schema");
    expect(prompt).toContain('{"name": "...", "arguments": {...}}');
    expect(prompt).toContain("Your reply must request at least one function.");
    expect(prompt.toLowerCase()).not.toMatch(/\btool\b|tool_call|channel|computer|execute/);
  });

  it("parses one fenced block and keeps text before it", () => {
    expect(parseToolCalls('I will read it.\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```')).toEqual({
      text: "I will read it.",
      calls: [{ name: "read_file", argumentsJson: '{"path":"a.txt"}' }],
    });
  });

  it("parses several blocks, a language-less block and a detached json line", () => {
    const parsed = parseToolCalls(
      '```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```\n\njson\n\n```\n{"name":"write_file","arguments":{"path":"b.txt"}}\n```',
    );
    expect(parsed.text).toBe("");
    expect(parsed.calls.map((call) => call.name)).toEqual(["read_file", "write_file"]);
  });

  it("supports tag fallback and four-backtick fences", () => {
    expect(parseToolCalls('<tool_call>{"name":"read_file","arguments":{}}</tool_call>').calls).toEqual([
      { name: "read_file", argumentsJson: "{}" },
    ]);
    expect(parseToolCalls('````\n{"name":"read_file","arguments":{}}\n````')).toEqual({
      text: "",
      calls: [{ name: "read_file", argumentsJson: "{}" }],
    });
  });

  it("holds a partial tag instead of streaming it as text", () => {
    const filter = createToolTextFilter();
    expect(filter.append("Before <tool")).toBe("Before ");
    expect(filter.append('_call>{"name":"read_file","arguments":{}}</tool_call>')).toBe("");
    expect(filter.finish().calls).toEqual([{ name: "read_file", argumentsJson: "{}" }]);
  });

  it("leaves malformed and incomplete call blocks untouched", () => {
    const malformed = 'before\n```json\n{"name":"read_file","arguments":}\n```';
    expect(parseToolCalls(malformed)).toEqual({ text: malformed, calls: [] });
    const missingFields = '```json\n{"name":"read_file"}\n```';
    expect(parseToolCalls(missingFields)).toEqual({ text: missingFields, calls: [] });
  });

  it("renders tool results and errors with the matching call name", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", argumentsJson: "{}" }] },
      { role: "tool", content: "missing", toolCallId: "call_1", isError: true },
    ];
    const rendered = renderToolResults(messages);
    expect(rendered).toContain("Function result of read_file (call call_1) (error):");
    expect(rendered).toContain("Continue: reply to the end user");
  });
});
