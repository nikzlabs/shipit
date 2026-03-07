/**
 * Integration tests for PUT /secrets worker endpoint (preview mode).
 *
 * Tests the session worker's secrets injection endpoint, which sets
 * environment variables in the preview container and restarts the dev
 * server if running.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SessionWorker } from "../../session/session-worker.js";
import type { AgentProcess, AgentProcessEvents, AgentId, AgentRunParams, PermissionMode } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Fake AgentProcess (required by SessionWorker constructor)
// ---------------------------------------------------------------------------

class FakeWorkerAgent extends EventEmitter<AgentProcessEvents> implements AgentProcess {
  readonly agentId: AgentId = "claude";
  readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: [] as PermissionMode[],
    toolNames: [] as string[],
    models: [] as string[],
  };
  run(_params: AgentRunParams): void {}
  writeStdin(_data: string): void {}
  interrupt(): void {}
  kill(): void {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Worker PUT /secrets (preview mode)", () => {
  let worker: SessionWorker;
  const originalEnv: Record<string, string | undefined> = {};
  const testKeys = ["TEST_SECRET_A", "TEST_SECRET_B", "TEST_SECRET_C"];

  beforeEach(async () => {
    // Save original env values
    for (const key of testKeys) {
      originalEnv[key] = process.env[key];
    }

    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workerMode: "preview",
    });
    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    // Restore original env values
    for (const key of testKeys) {
      if (originalEnv[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  });

  it("health check returns preview mode", async () => {
    const res = await worker.getApp().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", mode: "preview" });
  });

  it("PUT /secrets sets environment variables", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { TEST_SECRET_A: "value_a", TEST_SECRET_B: "value_b" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true, keyCount: 2 });
    expect(process.env.TEST_SECRET_A).toBe("value_a");
    expect(process.env.TEST_SECRET_B).toBe("value_b");
  });

  it("PUT /secrets full-replaces tracked keys", async () => {
    // First call sets A and B
    await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { TEST_SECRET_A: "a1", TEST_SECRET_B: "b1" },
    });
    expect(process.env.TEST_SECRET_A).toBe("a1");
    expect(process.env.TEST_SECRET_B).toBe("b1");

    // Second call sets only C — A and B should be removed
    await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { TEST_SECRET_C: "c1" },
    });
    expect(process.env.TEST_SECRET_A).toBeUndefined();
    expect(process.env.TEST_SECRET_B).toBeUndefined();
    expect(process.env.TEST_SECRET_C).toBe("c1");
  });

  it("PUT /secrets with empty object clears all tracked keys", async () => {
    await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { TEST_SECRET_A: "value" },
    });
    expect(process.env.TEST_SECRET_A).toBe("value");

    await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: {},
    });
    expect(process.env.TEST_SECRET_A).toBeUndefined();
  });

  // ---- Mode gating ----

  it("preview mode does not register agent endpoints", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "test" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("preview mode does not register terminal endpoints", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/terminal/start",
    });
    expect(res.statusCode).toBe(404);
  });

  it("preview mode does not register file watcher endpoints", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/files/watch",
    });
    expect(res.statusCode).toBe(404);
  });

  it("preview mode registers preview endpoints", async () => {
    const statusRes = await worker.getApp().inject({
      method: "GET",
      url: "/preview/status",
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({ running: false, ports: [] });
  });
});

describe("Integration: Session mode does not register preview endpoints", () => {
  let worker: SessionWorker;

  beforeEach(async () => {
    worker = new SessionWorker({
      agentFactory: () => new FakeWorkerAgent(),
      port: 0,
      host: "127.0.0.1",
      workerMode: "session",
    });
    await worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("session mode does not register PUT /secrets", async () => {
    const res = await worker.getApp().inject({
      method: "PUT",
      url: "/secrets",
      payload: { KEY: "value" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("session mode does not register preview endpoints", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/preview/start",
    });
    expect(res.statusCode).toBe(404);
  });

  it("session mode registers agent endpoints", async () => {
    const res = await worker.getApp().inject({
      method: "GET",
      url: "/agent/status",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ running: false });
  });
});
