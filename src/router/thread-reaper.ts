import type { Logger } from "pino";
import { ThreadDeleteRefusedError, type MuseDriver } from "../core/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { ThreadRegistry } from "../sessions/thread-registry.js";
import type { TurnSlots } from "./slots.js";

const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export interface ThreadReaperOptions {
  driver: MuseDriver;
  registry: ThreadRegistry;
  sessions: SessionStore;
  slots: TurnSlots;
  log?: Pick<Logger, "info" | "warn" | "debug">;
  /** `SIDE_THREAD_IDLE_SEC` */
  idleSec: number;
  /** `MAX_SIDE_THREADS` */
  cap: number;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Background loop that deletes retirable threads:
 * - Retired threads (e.g. rotated primary or expired warm chats)
 * - Side threads idle for more than idleSec
 * - Least-recently-used idle side threads over cap
 *
 * Runs without ever blocking client requests (acquires slot with 0 timeout).
 */
export class ThreadReaper {
  private readonly driver: MuseDriver;
  private readonly registry: ThreadRegistry;
  private readonly sessions: SessionStore;
  private readonly slots: TurnSlots;
  private readonly log: Pick<Logger, "info" | "warn" | "debug">;
  private readonly idleMs: number;
  private readonly cap: number;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private abort = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(options: ThreadReaperOptions) {
    this.driver = options.driver;
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.slots = options.slots;
    this.log = options.log ?? {
      info: () => {},
      warn: () => {},
      debug: () => {},
    };
    this.idleMs = options.idleSec * 1000;
    this.cap = options.cap;
    this.intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.clock = options.now ?? Date.now;
  }

  /** Starts the reaper check loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.abort.signal.aborted) {
      this.abort = new AbortController();
    }
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  /** Halts periodic checks, aborts in-flight work, and awaits completion. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort.abort();
    const inFlight = this.inFlight;
    if (inFlight) await inFlight;
  }

  /**
   * Checks for retirable threads and deletes them one at a time until
   * none are retirable or no slot is free.
   */
  async check(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return;
    if (this.slots.activeCount >= this.slots.max) return;

    this.running = true;
    const task = this.reapLoop();
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) {
        this.inFlight = undefined;
      }
      this.running = false;
    }
  }

  private async reapLoop(): Promise<void> {
    if (!this.driver.deleteThread) return;

    while (!this.abort.signal.aborted) {
      if (this.slots.activeCount >= this.slots.max) {
        break;
      }

      const now = this.clock();
      const retirable = this.registry.retirable(now, this.idleMs, this.cap);
      const nextId = retirable[0];
      if (!nextId) {
        break;
      }

      let release: (() => void) | null = null;
      try {
        release = await this.slots.acquire(0, this.abort.signal);
        if (!release) {
          break;
        }
        if (this.abort.signal.aborted) {
          break;
        }

        const row = this.registry.get(nextId);
        if (row && row.inFlight > 0) {
          continue;
        }

        const role = row?.role ?? "unknown";
        const idleSec = row && row.lastUsedAt > 0 ? Math.max(0, Math.round((now - row.lastUsedAt) / 1000)) : 0;

        // Drop the sessions first so no request resumes the chat while it is being deleted; a
        // client coming back simply starts a fresh chat.
        this.sessions.deleteByConversation(nextId);
        await this.driver.deleteThread(nextId);
        this.registry.forget(nextId);
        this.log.info(
          { conversationId: nextId, role, idleSec },
          "Deleted retirable Muse thread",
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error instanceof ThreadDeleteRefusedError) {
          // Muse keeps refusing the same chat for hours, so retrying only spends a tab. Its
          // sessions are already gone, so no request can land there again: leave it in Muse.
          this.registry.forget(nextId);
          this.log.info({ conversationId: nextId, err: error.message }, "Muse refused to delete thread; no longer tracking it");
          continue;
        }
        this.registry.noteRetireFailure(nextId, this.clock());
        this.log.warn(
          { conversationId: nextId, err: error.message },
          "Failed to delete retirable Muse thread; scheduled backoff",
        );
      } finally {
        release?.();
      }
    }
  }
}
