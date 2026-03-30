/**
 * Integration tests for worker service control endpoints and the
 * SSE request/callback bridge to the orchestrator.
 *
 * Tests cover:
 * 1. Worker service HTTP endpoints (list, start, stop, restart)
 * 2. SSE service_request events emitted by the worker
 * 3. Callback endpoint (/services/_callback) resolving pending requests
 * 4. Error handling (timeout, unknown request, missing name)
 *
 * Uses in-process Fastify with stubs — no Docker or real processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionWorker } from "../../session/session-worker.js";
import {
  FakeWorkerAgent,
  collectSSE,
  waitFor,
} from "./container-test-helpers.js";

// ---------------------------------------------------------------------------
// Worker Service Endpoints
// ---------------------------------------------------------------------------

describe("Worker Service Endpoints", () => {
  let worker: SessionWorker;

  beforeEach(async () => {
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
    });
    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
  });

  it("returns 400 for /services/start without name", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/services/start",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "name is required" });
  });

  it("returns 400 for /services/stop without name", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/services/stop",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for /services/restart without name", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/services/restart",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for /services/_callback without requestId", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/services/_callback",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for /services/_callback with unknown requestId", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/services/_callback",
      payload: { requestId: "unknown-123" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("emits service_request SSE event for /services/list", async () => {
    const events: { type: string; data: unknown }[] = [];
    const address = worker.getApp().addresses()[0];
    const workerUrl = `http://${address.address}:${address.port}`;

    const sse = collectSSE(workerUrl, (type, data) => {
      events.push({ type, data });
    });

    // Give SSE time to connect
    await new Promise(r => setTimeout(r, 100));

    // Fire off the list request (don't await — it blocks until callback)
    const listPromise = worker.getApp().inject({
      method: "GET",
      url: "/services/list",
    });

    // Wait for the SSE event to arrive
    await waitFor(() => events.some(e => e.type === "service_request"), 3000, "service_request SSE event");

    const svcEvent = events.find(e => e.type === "service_request");
    expect(svcEvent).toBeDefined();
    const eventData = svcEvent!.data as { requestId: string; action: string };
    expect(eventData.action).toBe("list");
    expect(eventData.requestId).toBeDefined();

    // Now simulate the orchestrator callback
    const callbackRes = await worker.getApp().inject({
      method: "POST",
      url: "/services/_callback",
      payload: {
        requestId: eventData.requestId,
        result: { services: [{ name: "web", status: "running", port: 3000, preview: "auto" }] },
      },
    });
    expect(callbackRes.statusCode).toBe(200);

    // The list request should now resolve
    const listRes = await listPromise;
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toMatchObject({
      services: [{ name: "web", status: "running", port: 3000, preview: "auto" }],
    });

    sse.close();
  });

  it("emits service_request SSE event for /services/start", async () => {
    const events: { type: string; data: unknown }[] = [];
    const address = worker.getApp().addresses()[0];
    const workerUrl = `http://${address.address}:${address.port}`;

    const sse = collectSSE(workerUrl, (type, data) => {
      events.push({ type, data });
    });

    await new Promise(r => setTimeout(r, 100));

    const startPromise = worker.getApp().inject({
      method: "POST",
      url: "/services/start",
      payload: { name: "db" },
    });

    await waitFor(() => events.some(e => e.type === "service_request"), 3000, "service_request SSE event");

    const svcEvent = events.find(e => e.type === "service_request");
    const eventData = svcEvent!.data as { requestId: string; action: string; name: string };
    expect(eventData.action).toBe("start");
    expect(eventData.name).toBe("db");

    // Simulate callback
    await worker.getApp().inject({
      method: "POST",
      url: "/services/_callback",
      payload: { requestId: eventData.requestId, result: { ok: true, name: "db", status: "running" } },
    });

    const res = await startPromise;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "db", status: "running" });

    sse.close();
  });

  it("resolves with error when callback contains error", async () => {
    const events: { type: string; data: unknown }[] = [];
    const address = worker.getApp().addresses()[0];
    const workerUrl = `http://${address.address}:${address.port}`;

    const sse = collectSSE(workerUrl, (type, data) => {
      events.push({ type, data });
    });

    await new Promise(r => setTimeout(r, 100));

    const stopPromise = worker.getApp().inject({
      method: "POST",
      url: "/services/stop",
      payload: { name: "nonexistent" },
    });

    await waitFor(() => events.some(e => e.type === "service_request"), 3000, "service_request SSE event");

    const svcEvent = events.find(e => e.type === "service_request");
    const eventData = svcEvent!.data as { requestId: string };

    // Simulate error callback
    await worker.getApp().inject({
      method: "POST",
      url: "/services/_callback",
      payload: { requestId: eventData.requestId, error: "Unknown service: nonexistent" },
    });

    const res = await stopPromise;
    // The promise rejects with an error, which Fastify converts to a 500
    expect(res.statusCode).toBe(500);

    sse.close();
  });
});
