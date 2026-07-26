/**
 * Integration tests for the worker lifecycle-route guard
 * (shared/worker-auth.ts) — the structural fix for the dogfooding self-kill
 * (prod incident 2026-07-25, session 6e1e22fa).
 *
 * Anything inside a session container can reach the worker on
 * 127.0.0.1:9100 — including the agent's own shell children (a test suite,
 * a stray script). Without a guard, an unauthenticated POST /agent/start
 * gets a 409 while the real agent is mid-turn, and orchestrator-side
 * persistent-409 recovery escalates to /agent/kill: the live agent dies.
 * With the guard, an orchestrator-issued per-container secret is required
 * on the lifecycle-mutating /agent/* routes, so the rogue caller gets a 401
 * BEFORE the 409 — the recovery loop never arms, and /agent/kill itself is
 * unreachable.
 *
 * Covered here:
 *  - guarded worker: 401 on protected routes without/with a wrong header;
 *    the resident agent survives an unauthenticated kill (the incident shape)
 *  - guarded worker: the orchestrator's ContainerSessionRunner, holding the
 *    secret, drives the full run/interrupt/kill path over real HTTP
 *  - the shim surfaces the agent's children legitimately use stay open
 *  - no secret configured → prior unauthenticated behavior (test/subprocess
 *    mode back-compat)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionWorker } from "../../session/session-worker.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { workerPost } from "../worker-http.js";
import {
  WORKER_LIFECYCLE_SECRET_HEADER,
  generateLifecycleSecret,
} from "../../shared/worker-auth.js";
import { FakeWorkerAgent, waitFor } from "./container-test-helpers.js";

describe("worker lifecycle-route guard", () => {
  let worker: SessionWorker;
  let lastAgent: FakeWorkerAgent;
  let secret: string;

  beforeEach(async () => {
    lastAgent = null as unknown as FakeWorkerAgent;
    secret = generateLifecycleSecret();
    worker = new SessionWorker({
      agentFactory: () => {
        lastAgent = new FakeWorkerAgent();
        return lastAgent;
      },
      port: 0,
      host: "127.0.0.1",
      lifecycleSecret: secret,
    });
  });

  afterEach(async () => {
    await worker.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  const startBody = { agentId: "claude", params: { prompt: "hi" } };

  it("rejects /agent/start without the secret and never instantiates an agent", async () => {
    const res = await worker.getApp().inject({ method: "POST", url: "/agent/start", payload: startBody });
    expect(res.statusCode).toBe(401);
    expect(lastAgent).toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: startBody,
      headers: { [WORKER_LIFECYCLE_SECRET_HEADER]: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(lastAgent).toBeNull();
  });

  it("accepts the correct secret", async () => {
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: startBody,
      headers: { [WORKER_LIFECYCLE_SECRET_HEADER]: secret },
    });
    expect(res.statusCode).toBe(200);
    expect(lastAgent.runCalled).toBe(true);
  });

  it("the resident agent survives an unauthenticated kill/interrupt (the incident shape)", async () => {
    // Start the resident agent as the orchestrator would.
    await worker.getApp().inject({
      method: "POST",
      url: "/agent/start",
      payload: startBody,
      headers: { [WORKER_LIFECYCLE_SECRET_HEADER]: secret },
    });
    const resident = lastAgent;
    expect(resident.runCalled).toBe(true);

    // A rogue in-container caller (e.g. a test orchestrator built by a suite
    // running in the workspace) tries the incident sequence: start → would
    // have been 409 → kill. Every step must now die on 401 instead.
    const rogueStart = await worker.getApp().inject({ method: "POST", url: "/agent/start", payload: startBody });
    expect(rogueStart.statusCode).toBe(401); // NOT 409 — the recovery loop never arms
    const rogueKill = await worker.getApp().inject({ method: "POST", url: "/agent/kill" });
    expect(rogueKill.statusCode).toBe(401);
    const rogueInterrupt = await worker.getApp().inject({ method: "POST", url: "/agent/interrupt" });
    expect(rogueInterrupt.statusCode).toBe(401);

    expect(resident.killed).toBe(false);
    expect(resident.interrupted).toBe(false);

    // The legitimate holder can still kill it.
    const kill = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
      headers: { [WORKER_LIFECYCLE_SECRET_HEADER]: secret },
    });
    expect(kill.statusCode).toBe(200);
    expect(resident.killed).toBe(true);
  });

  it("guards every lifecycle-mutating route", async () => {
    for (const url of [
      "/agent/interrupt",
      "/agent/kill",
      "/agent/spawn",
      "/agent/cancel",
      "/agent/stdin",
      "/agent/message",
      "/agent/permission-mode",
      "/agent/compact",
      "/agent/permission/resolve",
    ]) {
      const res = await worker.getApp().inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("leaves health, status, and the agent-shim surfaces open", async () => {
    const health = await worker.getApp().inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const status = await worker.getApp().inject({ method: "GET", url: "/agent/status" });
    expect(status.statusCode).toBe(200);

    // Shim brokers respond with their own validation (400), not a 401 —
    // the agent's children keep their legitimate surfaces.
    const permission = await worker.getApp().inject({
      method: "POST",
      url: "/agent-ops/permission/request",
      payload: {},
    });
    expect(permission.statusCode).toBe(400);

    const ask = await worker.getApp().inject({ method: "POST", url: "/agent-ops/ask/submit", payload: {} });
    expect(ask.statusCode).toBe(400);
  });

  it("orchestrator runner holding the secret drives the full path over real HTTP", async () => {
    const address = await worker.start();
    const match = /:(\d+)$/.exec(address);
    const workerUrl = `http://127.0.0.1:${match ? Number(match[1]) : 0}`;

    const runner = new ContainerSessionRunner({
      sessionId: "lifecycle-auth-test",
      sessionDir: "/tmp/lifecycle-auth-test",
      defaultAgentId: "claude",
      workerUrl,
      workerSecret: secret,
    });
    runner.attachViewer();
    await new Promise((r) => setTimeout(r, 200));

    const proxy = runner.createAgent("claude");
    proxy.run({ prompt: "authorized turn", cwd: "/tmp" });
    await waitFor(() => lastAgent?.runCalled, 3000, "authorized agent.run()");
    const resident = lastAgent;

    // A rogue direct POST (no header) against the same live worker cannot
    // touch the running agent.
    await expect(workerPost(workerUrl, "/agent/kill")).rejects.toThrow(/lifecycle secret/);
    expect(resident.killed).toBe(false);

    // The runner's own kill (with header) works.
    await runner.killAgentOnWorker();
    expect(resident.killed).toBe(true);

    runner.dispose();
  });
});

describe("worker without a lifecycle secret (back-compat)", () => {
  it("accepts unauthenticated /agent/* calls as before", async () => {
    let agent: FakeWorkerAgent | null = null;
    const worker = new SessionWorker({
      agentFactory: () => {
        agent = new FakeWorkerAgent();
        return agent;
      },
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const res = await worker.getApp().inject({
        method: "POST",
        url: "/agent/start",
        payload: { agentId: "claude", params: { prompt: "hi" } },
      });
      expect(res.statusCode).toBe(200);
      expect(agent!.runCalled).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});
