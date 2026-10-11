import { Agent, request } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "../helpers/server.js";

let gateway: TestGateway;
let agent: Agent;
const serverSockets: Socket[] = [];

beforeEach(async () => {
  gateway = await startTestGateway();
  gateway.app.server.on("connection", (socket: Socket) => serverSockets.push(socket));
  agent = new Agent({ keepAlive: true, maxSockets: 1 });
});

afterEach(async () => {
  agent.destroy();
  serverSockets.length = 0;
  await gateway.close();
});

/** POSTs a chat request over the shared keep-alive agent; resolves on the first body chunk or the end. */
function chat(body: object, onFirstChunk?: (destroy: () => void) => void): Promise<number> {
  const { port } = gateway.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        agent,
        headers: { authorization: `Bearer ${gateway.apiKey}`, "content-type": "application/json" },
      },
      (res) => {
        res.once("data", () => onFirstChunk?.(() => req.destroy()));
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("close", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", (err) => (onFirstChunk ? resolve(0) : reject(err)));
    req.end(JSON.stringify(body));
  });
}

describe("client abort wiring", () => {
  it("does not pile up close listeners on a keep-alive socket", async () => {
    for (let i = 0; i < 15; i++) {
      expect(await chat({ model: "muse", messages: [{ role: "user", content: `Hello ${i}` }] })).toBe(200);
    }
    expect(serverSockets).toHaveLength(1);
    expect(serverSockets[0].listenerCount("close")).toBeLessThan(5);
  });

  it("still aborts the Muse turn when the client disconnects mid-stream", async () => {
    gateway.driver.setFallback({ chunks: ["one ", "two ", "three"], delayMs: 50 });
    await chat({ model: "muse", stream: true, messages: [{ role: "user", content: "Hello" }] }, (destroy) => destroy());
    await expect.poll(() => gateway.driver.calls[0]?.signal.aborted).toBe(true);
  });
});
