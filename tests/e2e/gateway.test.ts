import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSse, startTestGateway, type TestGateway } from "../helpers/server.js";

let gateway: TestGateway;

beforeEach(async () => {
  gateway = await startTestGateway();
});

afterEach(async () => {
  await gateway.close();
});

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${gateway.apiKey}`, "content-type": "application/json", ...extra };
}

describe("gateway", () => {
  it("requires an API key and serves health without one", async () => {
    const health = await gateway.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, browser: { browserOpen: true } });

    const denied = await gateway.app.inject({ method: "GET", url: "/v1/models" });
    expect(denied.statusCode).toBe(401);

    const models = await gateway.app.inject({ method: "GET", url: "/v1/models", headers: auth() });
    expect(models.json().data.map((m: { id: string }) => m.id)).toContain("muse-spark-thinking");
  });

  it("reports Muse's account usage, and maps a failed lookup to an error response", async () => {
    const denied = await gateway.app.inject({ method: "GET", url: "/v1/usage" });
    expect(denied.statusCode).toBe(401);

    const ok = await gateway.app.inject({ method: "GET", url: "/v1/usage", headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ entries: [{ label: "Free plan", percentUsed: 20 }] });

    gateway.driver.setUsage({ ok: false, kind: "auth", message: "Muse session is not signed in" });
    const failed = await gateway.app.inject({ method: "GET", url: "/v1/usage", headers: auth() });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.message).toMatch(/not signed in/);
  });

  it("answers a non-streaming OpenAI request and records the session", async () => {
    const res = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Hello" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("Hello from Muse.\n\nSecond paragraph.");
    expect(res.headers["x-mta-session-reused"]).toBe("0");
    expect(res.headers["x-mta-cache-hit"]).toBe("0");
    expect(gateway.driver.calls[0]).toMatchObject({ prompt: "Hello", mode: "default", conversationId: undefined });
    expect(gateway.sessions.size).toBe(1);
  });

  it("streams OpenAI chunks ending with [DONE]", async () => {
    const res = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse-spark", messages: [{ role: "user", content: "Hello" }], stream: true, stream_options: { include_usage: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = parseSse(res.payload);
    expect(frames.at(-1)?.data).toBe("[DONE]");
    const text = frames
      .slice(0, -1)
      .map((f) => JSON.parse(f.data))
      .map((c) => c.choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(text).toBe("Hello from Muse.\n\nSecond paragraph.");
    expect(gateway.driver.calls[0]?.mode).toBe("instant");
  });

  it("resumes the same Muse conversation for a follow-up and sends only the new message", async () => {
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "thread-1" }),
      payload: { model: "muse", messages: [{ role: "user", content: "Hello" }] },
    });
    const reply = first.json().choices[0].message.content as string;

    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "thread-1" }),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: reply },
          { role: "user", content: "And then?" },
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-session-reused"]).toBe("1");
    expect(second.headers["x-mta-conversation-id"]).toBe("https://muse.ai/c/abc");
    expect(gateway.driver.calls[1]).toMatchObject({ prompt: "And then?", conversationId: "https://muse.ai/c/abc" });
  });

  it("starts a fresh chat with the full transcript when the history does not match", async () => {
    const res = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "unknown history" },
          { role: "user", content: "Next" },
        ],
      },
    });
    expect(res.headers["x-mta-session-reused"]).toBe("0");
    expect(gateway.driver.calls[0]?.conversationId).toBeUndefined();
    expect(gateway.driver.calls[0]?.prompt).toContain("<conversation>");
    expect(gateway.driver.calls[0]?.prompt).toContain("Be brief.");
  });

  it("retries a dead resumed conversation as a fresh chat without leaking the failure", async () => {
    await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Hello" }] },
    });
    gateway.driver.enqueue({ error: { type: "error", kind: "browser", message: "conversation gone" } });
    gateway.driver.enqueue({ chunks: ["Fresh answer"], conversationId: "https://muse.ai/c/new" });

    const res = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hello from Muse.\n\nSecond paragraph." },
          { role: "user", content: "More" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("Fresh answer");
    expect(gateway.driver.calls).toHaveLength(3);
    expect(gateway.driver.calls[1]?.conversationId).toBe("https://muse.ai/c/abc");
    expect(gateway.driver.calls[2]?.conversationId).toBeUndefined();
    expect(gateway.driver.calls[2]?.prompt).toContain("<conversation>");
  });

  it("serves an identical request from the response cache", async () => {
    const payload = { model: "muse", messages: [{ role: "user", content: "Cache me" }] };
    await gateway.app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth(), payload });
    const again = await gateway.app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth(), payload });
    expect(again.headers["x-mta-cache-hit"]).toBe("1");
    expect(again.json().choices[0].message.content).toBe("Hello from Muse.\n\nSecond paragraph.");
    expect(gateway.driver.calls).toHaveLength(1);
  });

  it("maps driver errors to HTTP statuses", async () => {
    gateway.driver.enqueue({ error: { type: "error", kind: "auth", message: "not signed in" } });
    const authFailure = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "x" }] },
    });
    expect(authFailure.statusCode).toBe(502);
    expect(authFailure.json().error.code).toBe("upstream_auth");

    gateway.driver.enqueue({ error: { type: "error", kind: "rate_limit", message: "slow down", retryAfterSec: 120 } });
    const limited = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "y" }], stream: true },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("120");
  });

  it("rejects unknown models and returns OpenAI tool calls", async () => {
    const unknown = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-4o", messages: [{ role: "user", content: "x" }] },
    });
    expect(unknown.statusCode).toBe(404);

    gateway.driver.enqueue({ chunks: ["Before\n```tool_call\n", '{"name":"read_file","arguments":{"path":"a.txt"}}', "\n```"] });
    const tools = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [{ role: "user", content: "Read a file" }],
        tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
      },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().choices[0].finish_reason).toBe("tool_calls");
    expect(tools.json().choices[0].message.content).toBe("Before");
    expect(tools.json().choices[0].message.tool_calls[0]).toMatchObject({
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
    });
    expect(gateway.driver.calls[0]?.prompt).toContain("read_file(arguments schema)");
    expect(gateway.driver.calls[0]?.prompt).toContain("fenced code block");
  });

  it("filters fenced calls from OpenAI streams and finishes with tool_calls", async () => {
    gateway.driver.enqueue({ chunks: ["json", "\n\n```", "\n{\"name\":\"read_file\",\"arguments\":{}}", "\n```"] });
    const response = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [{ role: "user", content: "Stream a call" }],
        stream: true,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      },
    });
    const frames = parseSse(response.payload).map((frame) => (frame.data === "[DONE]" ? frame.data : JSON.parse(frame.data)));
    const chunks = frames.filter((frame): frame is { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> } => frame !== "[DONE]");
    expect(chunks.every((frame) => !frame.choices[0]!.delta.content?.includes("```") && !frame.choices[0]!.delta.content?.includes("tool_call"))).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(frames.at(-1)).toBe("[DONE]");
  });

  it("resumes a tool-call conversation with tool results", async () => {
    const definition = { type: "function", function: { name: "read_file", parameters: { type: "object" } } };
    gateway.driver.enqueue({ chunks: ['```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```'] });
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "tools-1" }),
      payload: { model: "muse", messages: [{ role: "user", content: "Read it" }], tools: [definition] },
    });
    const firstCall = first.json().choices[0].message.tool_calls[0];
    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "tools-1" }),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Read it" },
          { role: "assistant", content: null, tool_calls: [firstCall] },
          { role: "tool", tool_call_id: firstCall.id, content: "hello" },
        ],
        tools: [definition],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-session-reused"]).toBe("1");
    expect(gateway.driver.calls[1]?.prompt).toContain("[tool_result id=");
    expect(gateway.driver.calls[1]?.prompt).toContain("Function result of read_file");

    const secondReply = second.json().choices[0].message.content as string;
    const third = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "tools-1" }),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Read it" },
          { role: "assistant", content: null, tool_calls: [firstCall] },
          { role: "tool", tool_call_id: firstCall.id, content: "hello" },
          { role: "assistant", content: secondReply },
          { role: "user", content: "Now summarize it" },
        ],
        tools: [definition],
      },
    });
    expect(third.statusCode).toBe(200);
    expect(third.headers["x-mta-session-reused"]).toBe("1");
    expect(gateway.driver.calls[2]?.prompt).toContain("[tool_result id=");
    expect(gateway.driver.calls[2]?.prompt).toContain("Now summarize it");
  });

  it("serializes Anthropic tool_use and bypasses the response cache", async () => {
    const definition = { name: "read_file", input_schema: { type: "object" } };
    gateway.driver.enqueue({ chunks: ['```\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```'] });
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth({ "anthropic-version": "2023-06-01" }),
      payload: { model: "muse", messages: [{ role: "user", content: "Read it" }], tools: [definition] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().stop_reason).toBe("tool_use");
    expect(first.json().content[0]).toMatchObject({ type: "tool_use", name: "read_file", input: { path: "a.txt" } });
    const callsAfterFirst = gateway.driver.calls.length;
    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth({ "anthropic-version": "2023-06-01" }),
      payload: { model: "muse", messages: [{ role: "user", content: "Read it again" }], tools: [definition] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-cache-hit"]).toBe("0");
    expect(gateway.driver.calls.length).toBe(callsAfterFirst + 1);
  });

  it("does not add the protocol when tool_choice is none", async () => {
    const response = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [{ role: "user", content: "No functions" }],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
        tool_choice: "none",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(gateway.driver.calls.at(-1)?.prompt).not.toContain("read_file(arguments schema)");
  });

  it("serves Anthropic messages in streaming and non-streaming form", async () => {
    const plain = await gateway.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth({ "anthropic-version": "2023-06-01" }),
      payload: { model: "muse-spark-thinking", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().content[0].text).toBe("Hello from Muse.\n\nSecond paragraph.");
    expect(gateway.driver.calls[0]?.mode).toBe("thinking");

    const streamed = await gateway.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth(),
      payload: { model: "muse", max_tokens: 100, messages: [{ role: "user", content: "Again" }], stream: true },
    });
    const events = parseSse(streamed.payload).map((f) => f.event);
    expect(events[0]).toBe("message_start");
    expect(events.at(-1)).toBe("message_stop");
  });

  it("returns 503 when every browser slot stays busy past the queue timeout", async () => {
    gateway.driver.setFallback({ chunks: ["slow"], delayMs: 1500 });
    const payload = (n: number) => ({ model: "muse", messages: [{ role: "user", content: `busy ${n}` }] });
    const inflight = [1, 2].map((n) =>
      gateway.app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth(), payload: payload(n) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await gateway.app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth(), payload: payload(3) });
    expect(third.statusCode).toBe(503);
    expect(third.headers["retry-after"]).toBe("1");
    const done = await Promise.all(inflight);
    expect(done.every((r) => r.statusCode === 200)).toBe(true);
  });
});

describe("cors on streaming responses", () => {
  it("keeps Access-Control-Allow-Origin on a streamed completion, not only on JSON replies", async () => {
    const origin = "http://localhost:5173";
    const json = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ origin }),
      payload: { model: "muse", messages: [{ role: "user", content: "Hello" }] },
    });
    expect(json.headers["access-control-allow-origin"]).toBe(origin);

    const stream = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ origin }),
      payload: { model: "muse", messages: [{ role: "user", content: "Hello" }], stream: true },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    // A browser silently drops the whole stream when this header is missing.
    expect(stream.headers["access-control-allow-origin"]).toBe(origin);
    expect(parseSse(stream.payload).at(-1)?.data).toBe("[DONE]");
  });
});
