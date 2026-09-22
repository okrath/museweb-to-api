import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { MuseDriver, TurnEvent } from "../core/types.js";
import { JsonStore } from "../store/json-store.js";
import type { TurnSlots } from "./slots.js";

const WARM_PROMPT = "Session start. Reply with exactly: Ready.";
const CHECK_INTERVAL_MS = 30_000;
const FAILURE_BACKOFF_MS = 60_000;

export interface WarmThread {
  conversationId: string;
  createdAt: number;
}

export interface WarmThreadPoolOptions {
  path: string;
  ttlSec: number;
  target: number;
  driver: MuseDriver;
  slots: TurnSlots;
  log: Pick<Logger, "debug" | "warn">;
  now?: () => number;
}

/** Persistent pool of side chats that have already completed their first turn. */
export class WarmThreadPool {
  private readonly store: JsonStore<WarmThread>;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly target: number;
  private readonly driver: MuseDriver;
  private readonly slots: TurnSlots;
  private readonly log: Pick<Logger, "debug" | "warn">;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private warming = false;
  private retryAfter = 0;
  private inFlight: Promise<boolean> | undefined;

  constructor(options: WarmThreadPoolOptions) {
    this.store = new JsonStore<WarmThread>(options.path);
    this.clock = options.now ?? Date.now;
    this.ttlMs = options.ttlSec * 1000;
    this.target = options.ttlSec > 0 ? options.target : 0;
    this.driver = options.driver;
    this.slots = options.slots;
    this.log = options.log;
    this.pruneExpired(this.clock());
  }

  get size(): number {
    this.pruneExpired(this.clock());
    return this.store.size;
  }

  /** Removes and returns one ready thread, oldest first. */
  take(now = this.clock()): WarmThread | undefined {
    if (this.target <= 0) return undefined;
    this.pruneExpired(now);
    const row = this.store
      .values()
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!row) return undefined;
    this.store.delete(row.conversationId);
    return row;
  }

  /** Starts the idle refill loop. It is safe to call once the listener is live. */
  start(): void {
    if (this.started || this.target <= 0) return;
    this.started = true;
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.check();
  }

  /** Stops new refills, waits for an in-progress refill, and persists the pool. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort.abort();
    const inFlight = this.inFlight;
    if (inFlight) await inFlight;
    this.store.flush();
  }

  /** Rechecks the target without waiting for a browser slot. */
  check(): void {
    if (!this.started || this.target <= 0 || this.warming) return;
    const now = this.clock();
    this.pruneExpired(now);
    if (this.store.size >= this.target || now < this.retryAfter || this.slots.activeCount >= this.slots.max) return;

    this.warming = true;
    const task = this.warmOne();
    this.inFlight = task;
    void task.then((succeeded) => {
      if (this.inFlight === task) this.inFlight = undefined;
      if (succeeded && this.started) this.check();
    });
  }

  private pruneExpired(now: number): void {
    this.store.prune((row) => row.createdAt + this.ttlMs > now);
  }

  private async warmOne(): Promise<boolean> {
    let release: (() => void) | null = null;
    try {
      release = await this.slots.acquire(0, this.abort.signal);
      if (!release) return false;
      if (!this.started) return false;

      let conversationId: string | undefined;
      let error: Extract<TurnEvent, { type: "error" }> | undefined;
      await this.driver.runTurn(
        {
          requestId: `warm_${randomUUID()}`,
          prompt: WARM_PROMPT,
          mode: "default",
          signal: this.abort.signal,
        },
        (event) => {
          if (event.type === "conversation") conversationId = event.conversationId;
          else if (event.type === "error") error = event;
        },
      );

      if (!this.started) return false;
      if (error) {
        this.fail(error.message);
        return false;
      }
      if (!conversationId) {
        this.fail("Muse warming completed without a conversation id");
        return false;
      }

      this.store.set(conversationId, { conversationId, createdAt: this.clock() });
      this.retryAfter = 0;
      this.log.debug({ conversationId }, "Warm Muse side chat ready");
      return true;
    } catch (err) {
      if (this.started) this.fail(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      release?.();
      this.warming = false;
    }
  }

  private fail(message: string): void {
    this.retryAfter = this.clock() + FAILURE_BACKOFF_MS;
    this.log.warn({ err: message }, "Warm Muse side chat failed; retrying after backoff");
  }
}
