import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../../src/sessions/session-store.js";
import { ThreadRegistry } from "../../src/sessions/thread-registry.js";
import { TurnSlots } from "../../src/router/slots.js";
import { ThreadReaper } from "../../src/router/thread-reaper.js";
import { WarmThreadPool } from "../../src/router/warm-pool.js";
import { FakeDriver } from "../helpers/fake-driver.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ThreadReaper", () => {
  let workDir: string;
  let driver: FakeDriver;
  let registry: ThreadRegistry;
  let sessions: SessionStore;
  let slots: TurnSlots;
  let now: number;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mta-reaper-"));
    dirs.push(workDir);
    driver = new FakeDriver();
    registry = new ThreadRegistry(join(workDir, "threads.json"));
    sessions = new SessionStore(join(workDir, "sessions.json"));
    slots = new TurnSlots(2);
    now = 1_000_000;
  });

  it("deletes side threads idle for > 300 seconds", async () => {
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
    });

    registry.touchSide("https://muse.ai/thread/side-1", now - 301_000);
    registry.touchSide("https://muse.ai/thread/side-2", now - 200_000);

    sessions.replace(null, {
      fingerprint: "fp1",
      conversationId: "https://muse.ai/thread/side-1",
      mode: "default",
      turns: 1,
      lastUsedAt: now - 301_000,
      expiresAt: now + 60_000,
    });

    await reaper.check();

    expect(driver.deletedThreads).toEqual(["https://muse.ai/thread/side-1"]);
    expect(registry.get("https://muse.ai/thread/side-1")).toBeUndefined();
    expect(sessions.find("fp1", now)).toBeUndefined();
    expect(registry.get("https://muse.ai/thread/side-2")).toBeDefined();
  });

  it("never deletes an in-flight thread", async () => {
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
    });

    registry.touchSide("https://muse.ai/thread/side-1", now - 400_000);
    registry.begin("https://muse.ai/thread/side-1");

    registry.retire("https://muse.ai/thread/retired-busy");
    registry.begin("https://muse.ai/thread/retired-busy");

    await reaper.check();

    expect(driver.deletedThreads).toEqual([]);
    expect(registry.get("https://muse.ai/thread/side-1")).toBeDefined();
    expect(registry.get("https://muse.ai/thread/retired-busy")).toBeDefined();

    registry.end("https://muse.ai/thread/side-1", now);
    registry.end("https://muse.ai/thread/retired-busy", now);

    await reaper.check();
    expect(driver.deletedThreads).toEqual(["https://muse.ai/thread/retired-busy"]);
  });

  it("evicts least-recently-used idle side threads when over cap", async () => {
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 2,
      now: () => now,
    });

    registry.touchSide("https://muse.ai/thread/s-1", now - 40_000);
    registry.touchSide("https://muse.ai/thread/s-2", now - 30_000);
    registry.touchSide("https://muse.ai/thread/s-3", now - 20_000);
    registry.touchSide("https://muse.ai/thread/s-4", now - 10_000);

    await reaper.check();

    expect(driver.deletedThreads).toEqual([
      "https://muse.ai/thread/s-1",
      "https://muse.ai/thread/s-2",
    ]);
    expect(registry.get("https://muse.ai/thread/s-1")).toBeUndefined();
    expect(registry.get("https://muse.ai/thread/s-2")).toBeUndefined();
    expect(registry.get("https://muse.ai/thread/s-3")).toBeDefined();
    expect(registry.get("https://muse.ai/thread/s-4")).toBeDefined();
  });

  it("backs off on deletion failure and logs at warn", async () => {
    const warnings: unknown[] = [];
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
      log: {
        info: () => {},
        warn: (obj) => warnings.push(obj),
        debug: () => {},
      },
    });

    const failId = "https://muse.ai/thread/fail-1";
    registry.touchSide(failId, now - 400_000);
    driver.setDeleteError(new Error("Muse 500 error"));

    await reaper.check();

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({
      conversationId: failId,
      err: "Muse 500 error",
    });

    const row = registry.get(failId);
    expect(row).toBeDefined();
    expect(row?.retireAttempts).toBe(1);
    expect(row?.retryAfter).toBeGreaterThan(now);

    driver.setDeleteError(undefined);
    await reaper.check();
    expect(driver.deletedThreads).toEqual([]);

    now += 70_000;
    await reaper.check();
    expect(driver.deletedThreads).toEqual([failId]);
    expect(registry.get(failId)).toBeUndefined();
  });

  it("never deletes active primary thread unless retired", async () => {
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 0,
      now: () => now,
    });

    const primaryId = "https://muse.ai/thread/primary-1";
    registry.setPrimary(primaryId, now - 500_000);

    await reaper.check();
    expect(driver.deletedThreads).toEqual([]);
    expect(registry.get(primaryId)?.role).toBe("primary");

    const newPrimaryId = "https://muse.ai/thread/primary-2";
    registry.setPrimary(newPrimaryId, now);

    await reaper.check();
    expect(driver.deletedThreads).toEqual([primaryId]);
    expect(registry.get(primaryId)).toBeUndefined();
    expect(registry.get(newPrimaryId)?.role).toBe("primary");
  });

  it("retires expired warm threads via WarmThreadPool and deletes them", async () => {
    const warmFile = join(workDir, "warm-threads.json");
    writeFileSync(
      warmFile,
      JSON.stringify({
        version: 1,
        entries: [
          [
            "https://muse.ai/thread/warm-1",
            { conversationId: "https://muse.ai/thread/warm-1", createdAt: now },
          ],
        ],
      }),
    );

    const warmPool = new WarmThreadPool({
      path: warmFile,
      ttlSec: 60,
      target: 1,
      driver,
      slots,
      log: { debug: () => {}, warn: () => {} },
      now: () => now,
      registry,
    });

    expect(warmPool.size).toBe(1);

    now += 70_000;

    expect(warmPool.size).toBe(0);
    expect(registry.get("https://muse.ai/thread/warm-1")?.role).toBe("retired");

    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
    });

    await reaper.check();
    expect(driver.deletedThreads).toContain("https://muse.ai/thread/warm-1");
    expect(registry.get("https://muse.ai/thread/warm-1")).toBeUndefined();
  });

  it("retires warm threads when warmPool.clear() is called", async () => {
    const warmFile = join(workDir, "warm-threads.json");
    writeFileSync(
      warmFile,
      JSON.stringify({
        version: 1,
        entries: [
          [
            "https://muse.ai/thread/warm-clear-1",
            { conversationId: "https://muse.ai/thread/warm-clear-1", createdAt: now },
          ],
        ],
      }),
    );

    const warmPool = new WarmThreadPool({
      path: warmFile,
      ttlSec: 300,
      target: 1,
      driver,
      slots,
      log: { debug: () => {}, warn: () => {} },
      now: () => now,
      registry,
    });

    expect(warmPool.size).toBe(1);

    warmPool.clear();
    expect(warmPool.size).toBe(0);
    expect(registry.get("https://muse.ai/thread/warm-clear-1")?.role).toBe("retired");

    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
    });

    await reaper.check();
    expect(driver.deletedThreads).toEqual(["https://muse.ai/thread/warm-clear-1"]);
  });

  it("skips deletion when all slots are occupied", async () => {
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
    });

    registry.touchSide("https://muse.ai/thread/side-idle", now - 500_000);

    const rel1 = await slots.acquire(0);
    const rel2 = await slots.acquire(0);
    expect(rel1).not.toBeNull();
    expect(rel2).not.toBeNull();
    expect(slots.activeCount).toBe(2);

    await reaper.check();
    expect(driver.deletedThreads).toEqual([]);
    expect(registry.get("https://muse.ai/thread/side-idle")).toBeDefined();

    rel1?.();
    await reaper.check();
    expect(driver.deletedThreads).toEqual(["https://muse.ai/thread/side-idle"]);

    rel2?.();
  });

  it("logs deletion at info with role and idleSec", async () => {
    const infoLogs: unknown[] = [];
    const reaper = new ThreadReaper({
      driver,
      registry,
      sessions,
      slots,
      idleSec: 300,
      cap: 10,
      now: () => now,
      log: {
        info: (obj) => infoLogs.push(obj),
        warn: () => {},
        debug: () => {},
      },
    });

    registry.touchSide("https://muse.ai/thread/side-logged", now - 450_000);

    await reaper.check();

    expect(infoLogs.length).toBe(1);
    expect(infoLogs[0]).toMatchObject({
      conversationId: "https://muse.ai/thread/side-logged",
      role: "side",
      idleSec: 450,
    });
  });

  it("supports start() and stop() lifecycle with deterministic fake timers", async () => {
    vi.useFakeTimers();
    try {
      const reaper = new ThreadReaper({
        driver,
        registry,
        sessions,
        slots,
        idleSec: 300,
        cap: 10,
        intervalMs: 50,
        now: () => now,
      });

      registry.touchSide("https://muse.ai/thread/side-auto", now - 400_000);

      reaper.start();
      await vi.advanceTimersByTimeAsync(50);

      expect(driver.deletedThreads).toEqual(["https://muse.ai/thread/side-auto"]);

      await reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
