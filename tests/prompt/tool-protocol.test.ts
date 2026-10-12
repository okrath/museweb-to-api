import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/types.js";
import { announcesWithoutRequest, createToolTextFilter, parseToolCalls, taskWithoutAnyRequest, renderToolProtocol, renderToolReminder, renderToolResults, toolName } from "../../src/prompt/tool-protocol.js";

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
    expect(prompt).toContain("must go in a later reply, once that response has arrived.");
    expect(renderToolReminder(tools)).toContain("must go in a later reply, once that response has arrived.");
    expect(renderToolReminder(tools).toLowerCase()).not.toMatch(/\btool\b|tool_call|channel|computer|execute/);
    expect(renderToolProtocol(tools, { name: "write_file" })).toContain("Your reply must send a request to `POST /api/write_file`.");
    expect(prompt.toLowerCase()).not.toMatch(/\btool\b|tool_call|channel|computer|execute/);
  });

  it("recognises a reply that announces an action instead of answering", () => {
    expect(announcesWithoutRequest("Now I'll create both files through the API:")).toBe(true);
    expect(announcesWithoutRequest("Delegating both lookups to two parallel read-only subagents.")).toBe(true);
    expect(announcesWithoutRequest("Two lookups dispatched in parallel. I'll report back once both come in.")).toBe(true);
    expect(announcesWithoutRequest("Let me check the config.")).toBe(true);
    expect(announcesWithoutRequest("The edit applied cleanly; now running the test to confirm.")).toBe(true);
    expect(announcesWithoutRequest("Nothing to do now: everything passes.")).toBe(false);
    expect(announcesWithoutRequest("3.4.5")).toBe(false);
    expect(announcesWithoutRequest("Done. Let me know if you need anything else.")).toBe(false);
    expect(announcesWithoutRequest("Should I delete the old file as well?")).toBe(false);
    expect(announcesWithoutRequest(`I'll summarise: ${"x".repeat(700)}`)).toBe(false);
  });

  it("doubts a finished answer only for a task in a conversation that never ran a request", () => {
    const task: ChatMessage[] = [{ role: "user", content: "Create stats.js and run the test" }];
    expect(taskWithoutAnyRequest(task)).toBe(true);
    expect(taskWithoutAnyRequest([{ role: "user", content: "What is the capital of France?" }])).toBe(false);
    expect(
      taskWithoutAnyRequest([
        ...task,
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", argumentsJson: "{}" }] },
        { role: "tool", content: "ok", toolCallId: "c1" },
        { role: "user", content: "Now run it again" },
      ]),
    ).toBe(false);
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

  it("parses a block whose fence was glued onto the sentence before it and came back escaped", () => {
    // As converted from Muse's page: the block rendered as a paragraph, so backticks, brackets and
    // backslashes are escaped and nothing closes the fence.
    const markdown =
      'Found four bugs in todo.js. Applying all fixes now.\\`\\`\\`json  \n{"endpoint": "/api/edit", "body": {"input": "\\[todo.js#0AF6\\]\\\\nPUT 3.=3:\\\\n+ add(title) { return \\\\"x\\\\"; }"}}';
    const parsed = parseToolCalls(markdown);
    expect(parsed.text).toBe("Found four bugs in todo.js. Applying all fixes now.");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]!.name).toBe("edit");
    expect(JSON.parse(parsed.calls[0]!.argumentsJson)).toEqual({ input: '[todo.js#0AF6]\nPUT 3.=3:\n+ add(title) { return "x"; }' });

    const filter = createToolTextFilter();
    expect(filter.append(markdown)).toBe("Found four bugs in todo.js. Applying all fixes now.");
    expect(filter.finish()).toMatchObject({ unsentText: "", calls: [{ name: "edit" }] });

    expect(parseToolCalls("Use \\`\\`\\` to open a fence.")).toEqual({ text: "Use \\`\\`\\` to open a fence.", calls: [] });
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
