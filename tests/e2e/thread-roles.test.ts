import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "../helpers/server.js";

const TASK_TOOL = { type: "function", function: { name: "task", parameters: {} } };
const READ_TOOL = { type: "function", function: { name: "read", parameters: {} } };
describe("thread roles and routing (e2e)", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  function auth(extra?: Record<string, string>) {
    return { authorization: `Bearer ${gateway.apiKey}`, ...extra };
  }

  it("consecutive main-agent turns resume the same primary id and do not rotate", async () => {
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Plan project" }], tools: [TASK_TOOL] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-mta-thread-role"]).toBe("primary");
    expect(first.headers["x-mta-session-reused"]).toBe("0");

    const primaryId = gateway.registry.primary()?.conversationId;
    expect(primaryId).toBeDefined();
    expect(gateway.registry.get(primaryId!)?.role).toBe("primary");

    const reply = first.json().choices[0].message.content as string;

    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Plan project" },
          { role: "assistant", content: reply },
          { role: "user", content: "Next step" },
        ],
        tools: [TASK_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-thread-role"]).toBe("primary");
    expect(second.headers["x-mta-session-reused"]).toBe("1");
    expect(second.headers["x-mta-conversation-id"]).toBe(primaryId);
    expect(gateway.registry.primary()?.conversationId).toBe(primaryId);
  });

  it("a new main conversation rotates the primary, retires the old, and drops old session rows", async () => {
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Session 1" }], tools: [TASK_TOOL] },
    });
    expect(first.statusCode).toBe(200);
    const oldPrimaryId = gateway.registry.primary()?.conversationId!;
    expect(oldPrimaryId).toBeDefined();

    // Divergent new main-agent conversation
    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Divergent session 2" }], tools: [TASK_TOOL] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-thread-role"]).toBe("primary");
    expect(second.headers["x-mta-session-reused"]).toBe("0");

    const newPrimaryId = gateway.registry.primary()?.conversationId!;
    expect(newPrimaryId).toBeDefined();
    expect(newPrimaryId).not.toBe(oldPrimaryId);

    // The rotation retires the old primary and nudges the reaper, which deletes it from Muse
    await expect.poll(() => gateway.driver.deletedThreads).toContain(oldPrimaryId);
    expect(gateway.registry.get(oldPrimaryId)).toBeUndefined();
    expect(gateway.registry.get(newPrimaryId)?.role).toBe("primary");
    expect(gateway.driver.deletedThreads).not.toContain(newPrimaryId);

    // Old primary session rows are removed
    const allSessions = gateway.sessions["store"].values();
    expect(allSessions.filter((s) => s.conversationId === oldPrimaryId)).toHaveLength(0);
    expect(allSessions.filter((s) => s.conversationId === newPrimaryId).length).toBeGreaterThan(0);
  });

  it("two parallel side conversations get different ids without touching primary", async () => {
    await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Lead" }], tools: [TASK_TOOL] },
    });
    const primaryId = gateway.registry.primary()?.conversationId!;

    const side1 = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Side task 1" }], tools: [READ_TOOL] },
    });
    expect(side1.statusCode).toBe(200);
    expect(side1.headers["x-mta-thread-role"]).toBe("side");

    const side2 = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Side task 2" }], tools: [READ_TOOL] },
    });
    expect(side2.statusCode).toBe(200);
    expect(side2.headers["x-mta-thread-role"]).toBe("side");

    expect(gateway.driver.calls[1].prompt).toContain("Side task 1");
    expect(gateway.driver.calls[2].prompt).toContain("Side task 2");
    expect(gateway.registry.primary()?.conversationId).toBe(primaryId);
  });

  it("tool-less requests are classified as side and do not rotate the primary", async () => {
    await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Lead" }], tools: [TASK_TOOL] },
    });
    const primaryId = gateway.registry.primary()?.conversationId!;

    const titleRes = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Summarize this" }] },
    });
    expect(titleRes.statusCode).toBe(200);
    expect(titleRes.headers["x-mta-thread-role"]).toBe("side");
    expect(gateway.registry.primary()?.conversationId).toBe(primaryId);
    expect(gateway.registry.get(primaryId)?.role).toBe("primary");
  });

  it("retry-fresh registers the new id and retires the failed one", async () => {
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Step one" }], tools: [TASK_TOOL] },
    });
    const firstPrimaryId = gateway.registry.primary()?.conversationId!;
    const reply = first.json().choices[0].message.content as string;

    gateway.driver.enqueue({ error: { type: "error", kind: "browser", message: "Turn crashed" } });

    const second = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Step one" },
          { role: "assistant", content: reply },
          { role: "user", content: "Step two" },
        ],
        tools: [TASK_TOOL],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-mta-thread-role"]).toBe("primary");

    const newPrimaryId = gateway.registry.primary()?.conversationId!;
    expect(newPrimaryId).toBeDefined();
    expect(newPrimaryId).not.toBe(firstPrimaryId);

    expect(gateway.registry.get(firstPrimaryId)?.role).toBe("retired");
    expect(gateway.registry.get(newPrimaryId)?.role).toBe("primary");

    const allSessions = gateway.sessions["store"].values();
    expect(allSessions.some((s) => s.conversationId === firstPrimaryId)).toBe(false);
  });

  it("in-flight count tracks turns and wraps driver runTurn on known id", async () => {
    const first = await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Initial turn" }], tools: [TASK_TOOL] },
    });
    const primaryId = gateway.registry.primary()?.conversationId!;
    expect(gateway.registry.get(primaryId)?.inFlight).toBe(0);

    const reply = first.json().choices[0].message.content as string;

    let inFlightDuringTurn = -1;
    const originalRunTurn = gateway.driver.runTurn.bind(gateway.driver);
    gateway.driver.runTurn = async (input, emit) => {
      if (input.conversationId) inFlightDuringTurn = gateway.registry.get(input.conversationId)?.inFlight ?? -1;
      return originalRunTurn(input, emit);
    };

    await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: {
        model: "muse",
        messages: [
          { role: "user", content: "Initial turn" },
          { role: "assistant", content: reply },
          { role: "user", content: "Next turn" },
        ],
        tools: [TASK_TOOL],
      },
    });

    expect(inFlightDuringTurn).toBe(1);
    expect(gateway.registry.get(primaryId)?.inFlight).toBe(0);
  });

  it("clean-threads clears registry", async () => {
    await gateway.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "muse", messages: [{ role: "user", content: "Primary turn" }], tools: [TASK_TOOL] },
    });
    expect(gateway.registry.size).toBeGreaterThan(0);
    gateway.driver.cleanAllThreads = async () => ({ deleted: 1, titles: ["Primary turn"] });
    const cleanRes = await gateway.app.inject({ method: "POST", url: "/v1/clean-threads", headers: auth() });
    expect(cleanRes.statusCode).toBe(200);
    expect(gateway.registry.size).toBe(0);
    expect(gateway.registry.primary()).toBeUndefined();
  });
});
