/**
 * Tests for the worker's agent controller routes — specifically the docs/144
 * sub-agent spawn lifecycle.
 *
 * The load-bearing case here is the one that used to leak: `shipit agent run`
 * blocks in the calling agent's shell, that shell call has its own wall-clock
 * cap (shorter than the sub-agent's 30-minute one), and when it expires the
 * shim is killed and the whole relay chain tears down. Cancellation used to
 * fire only from an explicit `/agent/cancel`, so the sub-agent kept running to
 * its own cap, spent the tokens, and wrote its answer into a socket nobody was
 * reading. These drive a REAL HTTP client disconnect (not `app.inject()`,
 * which cannot model one) and assert the spawn is killed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import http from "node:http";
import { EventEmitter } from "node:events";
import { AgentController } from "./agent-controller.js";

/** Minimal AgentProcess stand-in: never finishes on its own, kill() ends it. */
class FakeAgent extends EventEmitter {
  agentId = "codex";
  run = vi.fn();
  kill = vi.fn(() => {
    // Emulate the adapter reporting exit shortly after SIGTERM.
    queueMicrotask(() => this.emit("done", 0));
  });
}

describe("AgentController /agent/spawn", () => {
  let app: FastifyInstance;
  let agent: FakeAgent;
  let baseUrl: string;

  beforeEach(async () => {
    agent = new FakeAgent();
    app = Fastify({ logger: false });
    const controller = new AgentController({
      agentFactory: () => agent as never,
      workspaceDir: "/workspace",
      broadcast: () => {},
      permissionBroker: {} as never,
      mcpConfig: {} as never,
      latestSseSeq: () => 0,
    });
    controller.registerRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * POST /agent/spawn and hand back a handle that can hang up mid-flight,
   * plus a promise that settles once the worker has actually started the run
   * (so a test aborts a live spawn rather than racing the connect).
   */
  function spawnAndHangUp(): { abort: () => void; started: Promise<void> } {
    const payload = JSON.stringify({ agentId: "codex", prompt: "review this", spawnId: "sp1" });
    const req = http.request(`${baseUrl}/agent/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    });
    req.on("error", () => { /* expected once we hang up */ });
    req.end(payload);

    const started = new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (agent.run.mock.calls.length > 0) {
          clearInterval(tick);
          resolve();
        }
      }, 5);
      tick.unref?.();
    });
    return { abort: () => req.destroy(), started };
  }

  it("cancels the sub-agent when the caller hangs up mid-consult", async () => {
    const { abort, started } = spawnAndHangUp();
    await started;
    expect(agent.kill).not.toHaveBeenCalled();

    abort();

    await vi.waitFor(() => {
      expect(agent.kill).toHaveBeenCalled();
    });
  });

  it("does not cancel a spawn that completes normally", async () => {
    const payload = JSON.stringify({ agentId: "codex", prompt: "review this", spawnId: "sp2" });
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/agent/spawn`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (c: string) => { data += c; });
          res.on("end", () => resolve(JSON.parse(data) as Record<string, unknown>));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

    await vi.waitFor(() => {
      expect(agent.run).toHaveBeenCalled();
    });
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "no bugs found" }] });
    agent.emit("done", 0);

    const result = await done;
    // The success path must survive the abort wiring: `close` fires here too,
    // after the response is written, and must NOT be read as a hang-up.
    expect(result.status).toBe("success");
    expect(result.text).toBe("no bugs found");
  });
});
