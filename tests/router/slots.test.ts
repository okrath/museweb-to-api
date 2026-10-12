import { describe, expect, it } from "vitest";
import { TurnSlots } from "../../src/router/slots.js";

describe("TurnSlots", () => {
  it("hands a released slot to the waiter so a synchronous caller cannot take it in between", async () => {
    const slots = new TurnSlots(1);
    const releaseFirst = await slots.acquire(0);
    const waiting = slots.acquire(1_000);
    releaseFirst!();
    expect(slots.activeCount).toBe(1);
    expect(await slots.acquire(0)).toBeNull();
    const releaseWaiter = await waiting;
    expect(releaseWaiter).not.toBeNull();
    expect(slots.activeCount).toBe(1);
    releaseWaiter!();
    expect(slots.activeCount).toBe(0);
  });

  it("frees the slot when nobody is waiting and ignores a second release", async () => {
    const slots = new TurnSlots(2);
    const release = await slots.acquire(0);
    expect(slots.activeCount).toBe(1);
    release!();
    release!();
    expect(slots.activeCount).toBe(0);
  });

  it("gives up after the timeout without holding a slot", async () => {
    const slots = new TurnSlots(1);
    await slots.acquire(0);
    expect(await slots.acquire(10)).toBeNull();
    expect(slots.activeCount).toBe(1);
  });
});
