import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "../helpers/server.js";

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

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

function warmRows(): Array<{ conversationId: string; createdAt: number }> {
  try {
    const raw = JSON.parse(readFileSync(`${gateway.dataDir}/warm-threads.json`, "utf8")) as {
      entries?: Array<[string, { conversationId: string; createdAt: number }]>;
    };
    return (raw.entries ?? []).map(([, row]) => row);
  } catch {
    return [];
  }
}

describe("warm side-chat pool", () => {
  it("warms the configured side-chat pool after the server starts", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 2, maxConcurrentTurns: 3 });

    await waitFor(() => warmRows().length === 2);
    expect(gateway.driver.calls).toHaveLength(2);
    expect(gateway.driver.calls.every((call) => call.prompt === "Session start. Reply with exactly: Ready.")).toBe(true);
    expect(gateway.driver.calls.every((call) => call.conversationId === undefined && call.mode === "default")).toBe(true);
  });

  it("consumes a warm side chat with the full transcript and refills it", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 1, maxConcurrentTurns: 2 });
    await waitFor(() => warmRows().length === 1);
    const warmConversationId = warmRows()[0]!.conversationId;

    const response = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "warm-1" }),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Second" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-mta-warm-thread"]).toBe("1");
    const clientCall = gateway.driver.calls.find((call) => call.prompt.includes("Earlier answer"));
    expect(clientCall).toMatchObject({ conversationId: warmConversationId, mode: "default" });
    expect(clientCall?.prompt).toContain("First");
    expect(clientCall?.prompt).toContain("Second");
    await waitFor(() => gateway.driver.calls.filter((call) => call.prompt === "Session start. Reply with exactly: Ready.").length >= 2);
    await waitFor(() => warmRows().length === 1);
  });

  it("continues a conversation that was created from a warm side chat", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 1, maxConcurrentTurns: 2 });
    await waitFor(() => warmRows().length === 1);
    const warmConversationId = warmRows()[0]!.conversationId;

    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "warm-follow-up" }),
      payload: { model: "muse", messages: [{ role: "user", content: "Start here" }] },
    });
    const reply = first.json().choices[0].message.content as string;
    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth({ "x-conversation-id": "warm-follow-up" }),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Start here" },
          { role: "assistant", content: reply },
          { role: "user", content: "Continue here" },
        ],
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-session-reused"]).toBe("1");
    expect(second.headers["x-mta-warm-thread"]).toBe("0");
    expect(gateway.driver.calls.find((call) => call.prompt === "Continue here")).toMatchObject({ conversationId: warmConversationId });
  });

  it("falls back to a cold side chat when a warm thread fails before content", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 1, maxConcurrentTurns: 1 });
    await waitFor(() => warmRows().length === 1);
    const warmConversationId = warmRows()[0]!.conversationId;
    gateway.driver.enqueue({ error: { type: "error", kind: "browser", message: "warm thread gone" } });
    gateway.driver.enqueue({ chunks: ["Cold answer"], conversationId: "https://muse.ai/c/cold" });

    const response = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Fallback now" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("Cold answer");
    expect(response.headers["x-mta-warm-thread"]).toBe("1");
    expect(response.headers["x-mta-conversation-id"]).toBeUndefined();
    expect(gateway.driver.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prompt: "Fallback now", conversationId: warmConversationId }),
        expect.objectContaining({ prompt: "Fallback now", conversationId: undefined }),
      ]),
    );
  });

  it("does not warm or mark requests when WARM_THREADS is zero", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gateway.driver.calls).toHaveLength(0);

    const response = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "No warm pool" }] },
    });
    expect(response.headers["x-mta-warm-thread"]).toBe("0");
    expect(gateway.driver.calls[0]?.conversationId).toBeUndefined();
  });

  it("does not warm when session reuse is disabled", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 1, sessionTtlSec: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gateway.driver.calls).toHaveLength(0);
  });

  it("does not take a released slot away from a queued client", async () => {
    await gateway.close();
    gateway = await startTestGateway({ warmThreads: 1, maxConcurrentTurns: 1 });
    await waitFor(() => warmRows().length === 1);
    gateway.driver.setFallback({ chunks: ["Delayed answer"], delayMs: 100 });

    const first = gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "First queued" }] },
    });
    await waitFor(() => gateway.driver.calls.some((call) => call.prompt === "First queued"));
    const second = gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Second queued" }] },
    });

    await first;
    await waitFor(() => gateway.driver.calls.some((call) => call.prompt === "Second queued"));
    expect(gateway.driver.calls.filter((call) => call.prompt === "Session start. Reply with exactly: Ready.")).toHaveLength(1);
    await second;
    await waitFor(() => gateway.driver.calls.filter((call) => call.prompt === "Session start. Reply with exactly: Ready.").length === 2);
  });
});
