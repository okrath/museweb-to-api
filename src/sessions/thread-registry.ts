import { JsonStore } from "../store/json-store.js";

export type ThreadState = "primary" | "side" | "retired";

export interface ThreadRow {
  conversationId: string;
  role: ThreadState;
  lastUsedAt: number; // end of the last finished turn
  inFlight: number; // turns currently running on it (not persisted as truth)
  retireAttempts?: number;
  retryAfter?: number;
}

const RETIRE_BACKOFF_UNIT_MS = 60_000;
const RETIRE_BACKOFF_MAX_MS = 10 * 60_000;

export class ThreadRegistry {
  private readonly store: JsonStore<ThreadRow>;

  constructor(path: string) {
    this.store = new JsonStore<ThreadRow>(path);
    // On load, reset every inFlight to 0 (a persisted in-flight count is stale after a restart).
    for (const row of this.store.values()) {
      if (row.inFlight !== 0) {
        this.store.set(row.conversationId, {
          ...row,
          inFlight: 0,
        });
      }
    }
  }

  get(conversationId: string): ThreadRow | undefined {
    return this.store.get(conversationId);
  }

  get size(): number {
    return this.store.size;
  }

  rows(): ThreadRow[] {
    return this.store.values();
  }

  /** Returns the current primary thread row, if any. */
  primary(): ThreadRow | undefined {
    for (const row of this.store.values()) {
      if (row.role === "primary") {
        return row;
      }
    }
    return undefined;
  }

  /**
   * Designates `id` as the primary thread. Retires any previous primary thread
   * (if different) and returns the previous primary conversationId.
   */
  setPrimary(id: string, now: number): string | undefined {
    let prevPrimaryId: string | undefined;
    for (const row of this.store.values()) {
      if (row.role === "primary" && row.conversationId !== id) {
        this.store.set(row.conversationId, {
          ...row,
          role: "retired",
        });
        prevPrimaryId = row.conversationId;
      }
    }

    const existing = this.store.get(id);
    this.store.set(id, {
      conversationId: id,
      role: "primary",
      lastUsedAt: now,
      inFlight: existing?.inFlight ?? 0,
    });

    return prevPrimaryId;
  }

  /** Records or updates a side thread with last used timestamp. */
  touchSide(id: string, now: number): void {
    const existing = this.store.get(id);
    this.store.set(id, {
      conversationId: id,
      role: "side",
      lastUsedAt: now,
      inFlight: existing?.inFlight ?? 0,
    });
  }

  /** Marks the start of a turn on this thread, incrementing the in-flight counter. */
  begin(id: string): void {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, {
        ...existing,
        inFlight: Math.max(0, existing.inFlight) + 1,
      });
    } else {
      this.store.set(id, {
        conversationId: id,
        role: "side",
        lastUsedAt: 0,
        inFlight: 1,
      });
    }
  }

  /** Marks the end of a turn on this thread, decrementing the in-flight counter and updating lastUsedAt. */
  end(id: string, now: number): void {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, {
        ...existing,
        lastUsedAt: now,
        inFlight: Math.max(0, existing.inFlight - 1),
      });
    } else {
      this.store.set(id, {
        conversationId: id,
        role: "side",
        lastUsedAt: now,
        inFlight: 0,
      });
    }
  }

  /** Marks a thread as retired. */
  retire(id: string): void {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, {
        ...existing,
        role: "retired",
      });
    } else {
      this.store.set(id, {
        conversationId: id,
        role: "retired",
        lastUsedAt: 0,
        inFlight: 0,
      });
    }
  }

  /**
   * Returns conversation IDs safe to delete:
   * - Retired rows
   * - Side rows idle for >= idleMs
   * - Least-recently-used idle side rows over `cap`
   *
   * Never returns:
   * - Any row with inFlight > 0
   * - Any row backing off (retryAfter > now)
   * - Active primary row
   */
  retirable(now: number, idleMs: number, cap: number): string[] {
    const result: string[] = [];
    const added = new Set<string>();

    const safeToRetire = (row: ThreadRow): boolean => {
      if (row.inFlight > 0) return false;
      if (row.retryAfter !== undefined && row.retryAfter > now) return false;
      return true;
    };

    // 1. Retired rows (never primary, inFlight === 0, not in backoff)
    const retiredRows = this.store
      .values()
      .filter((row) => row.role === "retired" && safeToRetire(row))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    for (const row of retiredRows) {
      if (!added.has(row.conversationId)) {
        added.add(row.conversationId);
        result.push(row.conversationId);
      }
    }

    // 2. Side rows
    const allSideRows = this.store.values().filter((row) => row.role === "side");

    // 2a. Idle side rows
    const idleSideRows = allSideRows
      .filter((row) => safeToRetire(row) && now - row.lastUsedAt >= idleMs)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    for (const row of idleSideRows) {
      if (!added.has(row.conversationId)) {
        added.add(row.conversationId);
        result.push(row.conversationId);
      }
    }

    // 2b. Over-cap side rows (LRU pick among side rows not yet retirable)
    const effectiveCap = Math.max(0, cap);
    const remainingSide = allSideRows.filter((row) => !added.has(row.conversationId));
    if (remainingSide.length > effectiveCap) {
      const overCapCount = remainingSide.length - effectiveCap;
      const lruCandidates = remainingSide
        .filter((row) => safeToRetire(row))
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      for (const row of lruCandidates.slice(0, overCapCount)) {
        if (!added.has(row.conversationId)) {
          added.add(row.conversationId);
          result.push(row.conversationId);
        }
      }
    }

    return result;
  }

  /** Forgets a thread after a confirmed deletion. */
  forget(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Records a failed deletion attempt and schedules exponential backoff:
   * 60 s * attempts, capped at 10 min.
   */
  noteRetireFailure(id: string, now: number): void {
    const existing = this.store.get(id);
    const attempts = (existing?.retireAttempts ?? 0) + 1;
    const backoffMs = Math.min(attempts * RETIRE_BACKOFF_UNIT_MS, RETIRE_BACKOFF_MAX_MS);
    const retryAfter = now + backoffMs;

    if (existing) {
      this.store.set(id, {
        ...existing,
        retireAttempts: attempts,
        retryAfter,
      });
    } else {
      this.store.set(id, {
        conversationId: id,
        role: "retired",
        lastUsedAt: 0,
        inFlight: 0,
        retireAttempts: attempts,
        retryAfter,
      });
    }
  }

  /** Clears all thread records. */
  clear(): void {
    this.store.prune(() => false);
    this.store.flush();
  }

  flush(): void {
    this.store.flush();
  }
}
