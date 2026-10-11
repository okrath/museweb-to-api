import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/sessions/session-store.js";
import { ThreadRegistry } from "../../src/sessions/thread-registry.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mta-registry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ThreadRegistry", () => {
  describe("primary and setPrimary", () => {
    it("returns undefined initially and records primary thread", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      expect(reg.primary()).toBeUndefined();

      const prev = reg.setPrimary("p-1", 1_000);
      expect(prev).toBeUndefined();

      const primary = reg.primary();
      expect(primary).toBeDefined();
      expect(primary?.conversationId).toBe("p-1");
      expect(primary?.role).toBe("primary");
      expect(primary?.lastUsedAt).toBe(1_000);
      expect(primary?.inFlight).toBe(0);
    });

    it("retires previous primary and returns its id when primary rotates", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.setPrimary("p-1", 1_000);

      const prev = reg.setPrimary("p-2", 2_000);
      expect(prev).toBe("p-1");
      expect(reg.primary()?.conversationId).toBe("p-2");
      expect(reg.get("p-1")?.role).toBe("retired");
      expect(reg.get("p-2")?.role).toBe("primary");
    });

    it("does not retire current primary when re-set with same id", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.setPrimary("p-1", 1_000);

      const prev = reg.setPrimary("p-1", 2_000);
      expect(prev).toBeUndefined();
      expect(reg.primary()?.conversationId).toBe("p-1");
      expect(reg.primary()?.lastUsedAt).toBe(2_000);
      expect(reg.get("p-1")?.role).toBe("primary");
    });

    it("maintains invariant that at most one row has role primary", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.setPrimary("p-1", 1_000);
      reg.setPrimary("p-2", 2_000);
      reg.setPrimary("p-3", 3_000);

      const primaries = reg.rows().filter((r) => r.role === "primary");
      expect(primaries).toHaveLength(1);
      expect(primaries[0]?.conversationId).toBe("p-3");
    });
  });

  describe("touchSide", () => {
    it("creates a new side thread with lastUsedAt", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);

      const row = reg.get("side-1");
      expect(row).toBeDefined();
      expect(row?.role).toBe("side");
      expect(row?.lastUsedAt).toBe(1_000);
      expect(row?.inFlight).toBe(0);
    });

    it("updates lastUsedAt and preserves inFlight", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);
      reg.begin("side-1");
      reg.touchSide("side-1", 2_000);

      const row = reg.get("side-1");
      expect(row?.lastUsedAt).toBe(2_000);
      expect(row?.inFlight).toBe(1);
    });
  });

  describe("begin and end (in-flight tracking)", () => {
    it("increments on begin and decrements on end, updating lastUsedAt", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);

      reg.begin("side-1");
      expect(reg.get("side-1")?.inFlight).toBe(1);

      reg.begin("side-1");
      expect(reg.get("side-1")?.inFlight).toBe(2);

      reg.end("side-1", 2_000);
      expect(reg.get("side-1")?.inFlight).toBe(1);
      expect(reg.get("side-1")?.lastUsedAt).toBe(2_000);

      reg.end("side-1", 3_000);
      expect(reg.get("side-1")?.inFlight).toBe(0);
      expect(reg.get("side-1")?.lastUsedAt).toBe(3_000);
    });

    it("does not decrement below 0", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);
      reg.end("side-1", 2_000);
      expect(reg.get("side-1")?.inFlight).toBe(0);
    });

    it("creates side row if begin called on unknown id", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.begin("fresh-side");
      expect(reg.get("fresh-side")?.role).toBe("side");
      expect(reg.get("fresh-side")?.inFlight).toBe(1);
    });
  });

  describe("retire", () => {
    it("marks an existing thread as retired without losing in-flight state", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);
      reg.begin("side-1");
      reg.retire("side-1");

      const row = reg.get("side-1");
      expect(row?.role).toBe("retired");
      expect(row?.inFlight).toBe(1);
    });
  });

  describe("retirable", () => {
    it("never returns a row with inFlight > 0", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-1", 1_000);
      reg.begin("side-1");
      reg.retire("retired-busy");
      reg.begin("retired-busy");

      // Even with long idle and low cap, in-flight rows are never retirable
      const ids = reg.retirable(10_000, 1_000, 1);
      expect(ids).toEqual([]);

      // Ending turns makes them retirable
      reg.end("side-1", 10_000);
      reg.end("retired-busy", 10_000);

      const afterEnd = reg.retirable(10_000, 1_000, 1);
      expect(afterEnd).toContain("retired-busy");
    });

    it("never returns an active primary row", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.setPrimary("p-1", 1_000);

      // Even when idle for long time
      const ids = reg.retirable(100_000, 1_000, 0);
      expect(ids).not.toContain("p-1");
    });

    it("returns retired rows immediately once not in flight", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.retire("r-1");
      reg.retire("r-2");

      const ids = reg.retirable(1_000, 300_000, 10);
      expect(ids).toContain("r-1");
      expect(ids).toContain("r-2");
    });

    it("returns side rows idle for >= idleMs", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("side-idle", 1_000);
      reg.touchSide("side-active", 9_500);

      // idleMs = 5000, now = 10000 -> side-idle is idle (9000 ms >= 5000), side-active is not (500 ms < 5000)
      const ids = reg.retirable(10_000, 5_000, 10);
      expect(ids).toEqual(["side-idle"]);
    });

    it("picks least-recently-used idle side rows when over cap", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      // 5 side threads, none idle yet (idleMs = 100_000, now = 1_000)
      reg.touchSide("s-1", 100);
      reg.touchSide("s-2", 200);
      reg.touchSide("s-3", 300);
      reg.touchSide("s-4", 400);
      reg.touchSide("s-5", 500);

      // Cap is 3 -> 2 least-recently-used rows over cap should be picked
      const ids = reg.retirable(1_000, 100_000, 3);
      expect(ids).toEqual(["s-1", "s-2"]);
    });

    it("skips in-flight row during LRU over-cap eviction", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("s-1", 100);
      reg.touchSide("s-2", 200);
      reg.touchSide("s-3", 300);
      reg.touchSide("s-4", 400);

      // s-1 is in-flight, so it cannot be evicted
      reg.begin("s-1");

      // Cap is 2 -> need to evict 2. s-1 is skipped, s-2 and s-3 are picked
      const ids = reg.retirable(1_000, 100_000, 2);
      expect(ids).toEqual(["s-2", "s-3"]);
    });
  });

  describe("restart resets in-flight", () => {
    it("resets every inFlight counter to 0 on load", () => {
      const filePath = join(tempDir(), "threads.json");

      // Gateway session 1: leaves rows in-flight
      const reg1 = new ThreadRegistry(filePath);
      reg1.touchSide("s-1", 1_000);
      reg1.begin("s-1");
      reg1.touchSide("s-2", 2_000);
      reg1.begin("s-2");
      reg1.flush();

      expect(reg1.get("s-1")?.inFlight).toBe(1);
      expect(reg1.get("s-2")?.inFlight).toBe(1);

      // Gateway session 2 (restart): inFlight must be 0
      const reg2 = new ThreadRegistry(filePath);
      expect(reg2.get("s-1")?.inFlight).toBe(0);
      expect(reg2.get("s-2")?.inFlight).toBe(0);

      // Rows are now retirable if idle
      const ids = reg2.retirable(10_000, 5_000, 10);
      expect(ids).toContain("s-1");
      expect(ids).toContain("s-2");
    });
  });

  describe("noteRetireFailure and backoff", () => {
    it("backs off exponentially up to 10 min and retirable respects backoff", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.retire("r-fail");

      const now = 1_000_000;
      // 1st failure: 60 s delay
      reg.noteRetireFailure("r-fail", now);
      const row1 = reg.get("r-fail");
      expect(row1?.retireAttempts).toBe(1);
      expect(row1?.retryAfter).toBe(now + 60_000);

      // Retirable respects backoff
      expect(reg.retirable(now, 1_000, 10)).toEqual([]);
      expect(reg.retirable(now + 30_000, 1_000, 10)).toEqual([]);
      // When backoff expires, it is retirable again
      expect(reg.retirable(now + 60_000, 1_000, 10)).toEqual(["r-fail"]);

      // 2nd failure: 2 * 60 s = 120 s delay
      reg.noteRetireFailure("r-fail", now + 60_000);
      const row2 = reg.get("r-fail");
      expect(row2?.retireAttempts).toBe(2);
      expect(row2?.retryAfter).toBe(now + 60_000 + 120_000);

      // 10th failure: 10 * 60 s = 600 s (10 min)
      for (let i = 3; i <= 10; i++) {
        reg.noteRetireFailure("r-fail", now);
      }
      expect(reg.get("r-fail")?.retireAttempts).toBe(10);
      expect(reg.get("r-fail")?.retryAfter).toBe(now + 600_000);

      // 11th failure: capped at 10 min
      reg.noteRetireFailure("r-fail", now);
      expect(reg.get("r-fail")?.retireAttempts).toBe(11);
      expect(reg.get("r-fail")?.retryAfter).toBe(now + 600_000);
    });
  });

  describe("forget and clear", () => {
    it("forgets a thread after deletion", () => {
      const reg = new ThreadRegistry(join(tempDir(), "threads.json"));
      reg.touchSide("s-1", 1_000);
      expect(reg.size).toBe(1);

      expect(reg.forget("s-1")).toBe(true);
      expect(reg.size).toBe(0);
      expect(reg.get("s-1")).toBeUndefined();
    });

    it("clears all records and flushes", () => {
      const filePath = join(tempDir(), "threads.json");
      const reg = new ThreadRegistry(filePath);
      reg.setPrimary("p-1", 1_000);
      reg.touchSide("s-1", 1_000);
      expect(reg.size).toBe(2);

      reg.clear();
      expect(reg.size).toBe(0);

      const reloaded = new ThreadRegistry(filePath);
      expect(reloaded.size).toBe(0);
    });
  });

  describe("SessionStore.deleteByConversation", () => {
    it("deletes sessions matching conversationId and preserves others", () => {
      const filePath = join(tempDir(), "sessions.json");
      const store = new SessionStore(filePath);

      store.replace(null, {
        fingerprint: "fp-1",
        conversationId: "conv-a",
        mode: "default",
        turns: 1,
        lastUsedAt: 1_000,
        expiresAt: 10_000,
      });
      store.replace(null, {
        fingerprint: "fp-2",
        conversationId: "conv-a",
        mode: "default",
        turns: 2,
        lastUsedAt: 2_000,
        expiresAt: 10_000,
      });
      store.replace(null, {
        fingerprint: "fp-3",
        conversationId: "conv-b",
        mode: "default",
        turns: 1,
        lastUsedAt: 3_000,
        expiresAt: 10_000,
      });
      expect(store.size).toBe(3);

      const removed = store.deleteByConversation("conv-a");
      expect(removed).toBe(2);
      expect(store.size).toBe(1);
      expect(store.find("fp-1", 1_000)).toBeUndefined();
      expect(store.find("fp-2", 1_000)).toBeUndefined();
      expect(store.find("fp-3", 1_000)).toBeDefined();
    });
  });
});
