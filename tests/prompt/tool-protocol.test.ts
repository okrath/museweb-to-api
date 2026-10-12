import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/types.js";
import { createToolTextFilter, parseToolCalls, renderToolProtocol, renderToolResults, toolName } from "../../src/prompt/tool-protocol.js";

const tools = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("tool prompt protocol", () => {
  it("renders every tool as an endpoint with its schema and choice contract without forbidden framing", () => {
    const prompt = renderToolProtocol(tools, "required");
    expect(prompt).toContain("exactly these 2 endpoints: `POST /api/read_file`, `POST /api/write_file`.");
    expect(prompt).toContain('<endpoint path="/api/read_file">');
    expect(prompt).toContain('<endpoint path="/api/write_file">');
    expect(prompt.match(/^<\/endpoint>$/gm)).toHaveLength(2);
    expect(prompt).toContain("Request body (JSON Schema):");
    expect(prompt).toContain('{"endpoint": "/api/...", "body": {...}}');
    expect(prompt).toContain("Your reply must send at least one request.");
    expect(renderToolProtocol(tools, { name: "write_file" })).toContain("Your reply must send a request to `POST /api/write_file`.");
    expect(prompt.toLowerCase()).not.toMatch(/\btool\b|tool_call|channel|computer|execute/);
  });

  it("maps an endpoint back to its tool name", () => {
    expect(toolName("/api/readABC")).toBe("readABC");
    expect(toolName("POST /api/read_file")).toBe("read_file");
    expect(toolName("http://localhost:3000/api/read_file?x=1")).toBe("read_file");
    expect(toolName("api/read_file")).toBe("read_file");
    expect(toolName("/api/a/b")).toBeNull();
  });

  it("parses an endpoint request block into a tool call", () => {
    expect(parseToolCalls('I will read it.\n```json\n{"endpoint":"/api/read_file","body":{"path":"a.txt"}}\n```')).toEqual({
      text: "I will read it.",
      calls: [{ name: "read_file", argumentsJson: '{"path":"a.txt"}' }],
    });
    expect(parseToolCalls('```json\n{"endpoint":"/api/list_files"}\n```').calls).toEqual([{ name: "list_files", argumentsJson: "{}" }]);
  });

  it("parses a raw HTTP request block", () => {
    const parsed = parseToolCalls('```http\nPOST /api/read_file HTTP/1.1\nContent-Type: application/json\n\n{"path":"a.txt"}\n```');
    expect(parsed).toEqual({ text: "", calls: [{ name: "read_file", argumentsJson: '{"path":"a.txt"}' }] });
    const other = "```http\nPOST /login\n\n{}\n```";
    expect(parseToolCalls(other)).toEqual({ text: other, calls: [] });
  });

  it("parses one fenced block in the earlier name/arguments format and keeps text before it", () => {
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
    const arrayBody = '```json\n{"endpoint":"/api/read_file","body":[]}\n```';
    expect(parseToolCalls(arrayBody)).toEqual({ text: arrayBody, calls: [] });
  });

  it("renders tool results and errors with the matching call name", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", argumentsJson: "{}" }] },
      { role: "tool", content: "missing", toolCallId: "call_1", isError: true },
    ];
    const rendered = renderToolResults(messages);
    expect(rendered).toContain("Response from POST /api/read_file (request call_1) (error):");
    expect(rendered).toContain("Continue: reply to the end user");
  });
});
