/**
 * Unit tests for ServiceRequestQueue.
 *
 * The per-request timeout (docs/238) is the interesting part: a single flat
 * deadline for every action broke `start` for exactly the heavy services that
 * need it, so the queue must honor a caller-chosen deadline and a caller-chosen
 * timeout message rather than baking in one of each.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceRequestQueue } from "./service-request-queue.js";

describe("ServiceRequestQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves a pending request via its requestId", async () => {
    const queue = new ServiceRequestQueue();
    const { requestId, promise } = queue.enqueue<{ ok: boolean }>("start");

    expect(queue.resolve(requestId, { ok: true })).toBe(true);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("returns false for an unknown requestId", () => {
    const queue = new ServiceRequestQueue();
    expect(queue.resolve("nope", {})).toBe(false);
    expect(queue.reject("nope", new Error("x"))).toBe(false);
  });

  it("times out at the constructor default when no per-request value is given", async () => {
    const queue = new ServiceRequestQueue(1_000);
    const { promise } = queue.enqueue("list");
    const assertion = expect(promise).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("honors a per-request timeout that overrides the queue default", async () => {
    const queue = new ServiceRequestQueue(1_000);
    const { promise } = queue.enqueue("start", { timeoutMs: 10_000 });
    let settled = false;
    void promise.catch(() => { settled = true; });

    // Past the queue default, well short of the per-request deadline.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it("uses a caller-supplied timeout message", async () => {
    const queue = new ServiceRequestQueue();
    const { promise } = queue.enqueue("start", {
      timeoutMs: 500,
      timeoutMessage: (action, ms) => `custom: ${action} ${ms}`,
    });
    const assertion = expect(promise).rejects.toThrow("custom: start 500");

    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it("a resolved request never fires its timeout", async () => {
    const queue = new ServiceRequestQueue(1_000);
    const { requestId, promise } = queue.enqueue("stop");
    queue.resolve(requestId, { ok: true });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("cancelAll drains every pending entry", async () => {
    const queue = new ServiceRequestQueue();
    const a = queue.enqueue("start");
    const b = queue.enqueue("list");

    const assertions = Promise.all([
      expect(a.promise).rejects.toThrow("shutting down"),
      expect(b.promise).rejects.toThrow("shutting down"),
    ]);
    queue.cancelAll("shutting down");
    await assertions;

    // Entries are gone, so a late callback is a no-op.
    expect(queue.resolve(a.requestId, {})).toBe(false);
  });
});
