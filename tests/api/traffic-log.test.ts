import { describe, expect, it } from "vitest";
import { trafficSummary } from "../../src/api/traffic-log.js";
import type { ChatRequest } from "../../src/core/types.js";

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: "req_1",
    dialect: "anthropic",
    model: "muse",
    stream: true,
    messages: [
      { role: "system", content: "You are the main agent.\n\nFollow the rules." },
      { role: "user", content: "Fix the bug" },
    ],
    conversationHint: "user_abc_session_1",
    tools: [
      { name: "Read", parameters: {} },
      { name: "Bash", parameters: {} },
    ],
    clientAbort: new AbortController().signal,
    ...overrides,
  };
}

describe("trafficSummary", () => {
  it("never logs credentials or transport headers", () => {
    const summary = trafficSummary(
      {
        authorization: "Bearer secret",
        "x-api-key": "secret",
        "x-auth-token": "secret",
        "anthropic-auth-token": "secret",
        cookie: "a=b",
        host: "127.0.0.1:8090",
        "user-agent": "claude-cli/9.9",
        "x-claude-code-session-id": "s1",
      },
      request(),
    );
    expect(summary.headers).toEqual({ "user-agent": "claude-cli/9.9", "x-claude-code-session-id": "s1" });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("logs only the opening of the system prompt and hashes the rest", () => {
    const summary = trafficSummary({}, request());
    expect(summary.systemHead).toBe("You are the main agent. Follow the rules.");
    expect(summary.toolNames).toEqual(["Bash", "Read"]);
    expect(summary.toolCount).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("Fix the bug");
    expect(JSON.stringify(summary)).not.toContain("user_abc_session_1");
  });

  it("tells two agents apart by system prompt and tool set but keeps the tool hash order-independent", () => {
    const main = trafficSummary({}, request());
    const reordered = trafficSummary({}, request({ tools: [{ name: "Bash", parameters: {} }, { name: "Read", parameters: {} }] }));
    const sub = trafficSummary(
      {},
      request({
        messages: [
          { role: "system", content: "You are a search subagent." },
          { role: "user", content: "Find callers" },
        ],
        tools: [{ name: "Read", parameters: {} }],
      }),
    );
    expect(reordered.toolsHash).toBe(main.toolsHash);
    expect(sub.systemHash).not.toBe(main.systemHash);
    expect(sub.toolsHash).not.toBe(main.toolsHash);
    expect(sub.firstUserHash).not.toBe(main.firstUserHash);
    expect(sub.hintHash).toBe(main.hintHash);
  });

  it("reports missing pieces as null", () => {
    const summary = trafficSummary({}, request({ messages: [{ role: "user", content: "hi" }], tools: undefined, conversationHint: undefined }));
    expect(summary).toMatchObject({ hintHash: null, systemHash: null, toolsHash: null, toolCount: 0, systemChars: 0 });
  });
});
