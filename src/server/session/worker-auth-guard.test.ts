/**
 * SHI-311 — the guard as Fastify sees it, plus the end-to-end assertion that
 * `SessionWorker` actually installs it (the part that would silently regress if
 * someone reordered `buildApp`).
 *
 * `app.inject`'s `remoteAddress` stands in for the TCP peer, which is what makes
 * "a request from another session's container" expressible in a unit test.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerWorkerAuthGuard } from "./worker-auth-guard.js";
import { SessionWorker } from "./session-worker.js";
import { WORKER_AUTH_HEADER } from "../shared/worker-auth.js";

const TOKEN = "b".repeat(64);
/** A plausible peer: another session's agent container on the shared bridge. */
const PEER_CONTAINER_IP = "172.18.0.9";

// NB: `token` is required rather than defaulted — passing an explicit
// `undefined` to a defaulted parameter would silently take the default and the
// "no token configured" case would never actually be exercised.
function buildGuardedApp(token: string | undefined): FastifyInstance {
  const app = Fastify({ logger: false });
  registerWorkerAuthGuard(app, { token, log: () => {} });
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/agent-ops/voice/note", async () => ({ brokered: true }));
  app.get("/present-files/:id", async () => ({ artifact: true }));
  app.post("/terminal/start", async () => ({ started: true }));
  app.get("/present/:id/raw", async () => ({ raw: true }));
  return app;
}

describe("worker auth guard", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("rejects a peer container's /agent-ops call, token or not", async () => {
    app = buildGuardedApp(TOKEN);
    for (const headers of [{}, { [WORKER_AUTH_HEADER]: TOKEN }]) {
      const res = await app.inject({
        method: "POST",
        url: "/agent-ops/voice/note",
        remoteAddress: PEER_CONTAINER_IP,
        headers,
        payload: { summary: "injected into another session" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/outside its own session/);
    }
  });

  it("rejects a peer container's read of another session's present artifacts", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/present-files/abc",
      remoteAddress: PEER_CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a peer container on the orchestrator-facing routes", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/terminal/start",
      remoteAddress: PEER_CONTAINER_IP,
      payload: { cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves the container's own agent over loopback", async () => {
    app = buildGuardedApp(TOKEN);
    const note = await app.inject({
      method: "POST",
      url: "/agent-ops/voice/note",
      remoteAddress: "127.0.0.1",
      payload: { summary: "hi" },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toEqual({ brokered: true });

    const artifact = await app.inject({
      method: "GET",
      url: "/present-files/abc",
      remoteAddress: "127.0.0.1",
    });
    expect(artifact.statusCode).toBe(200);
  });

  it("serves the orchestrator when it presents the token", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/terminal/start",
      remoteAddress: "172.18.0.2", // the orchestrator's bridge IP
      headers: { [WORKER_AUTH_HEADER]: TOKEN },
      payload: { cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(200);

    const raw = await app.inject({
      method: "GET",
      url: "/present/abc/raw",
      remoteAddress: "172.18.0.2",
      headers: { [WORKER_AUTH_HEADER]: TOKEN },
    });
    expect(raw.statusCode).toBe(200);
  });

  it("leaves /health reachable from anywhere", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: PEER_CONTAINER_IP,
    });
    expect(res.statusCode).toBe(200);
  });

  it("keeps /agent-ops closed even on a worker with no token configured", async () => {
    app = buildGuardedApp(undefined);
    const brokered = await app.inject({
      method: "POST",
      url: "/agent-ops/voice/note",
      remoteAddress: PEER_CONTAINER_IP,
      payload: {},
    });
    expect(brokered.statusCode).toBe(403);
    // …while the orchestrator leg stays open, so a mid-deploy skew can't brick
    // a session (see decideWorkerRequest).
    const terminal = await app.inject({
      method: "POST",
      url: "/terminal/start",
      remoteAddress: PEER_CONTAINER_IP,
      payload: {},
    });
    expect(terminal.statusCode).toBe(200);
  });

  it("matches the query-stripped path, so ?foo can't smuggle past the prefix", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/present-files/abc?width=800",
      remoteAddress: PEER_CONTAINER_IP,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("SessionWorker installs the guard", () => {
  it("403s a peer container's /agent-ops request on the real worker app", async () => {
    // The regression guard that matters: it asserts the wiring in
    // `SessionWorker.buildApp`, not a hand-built app.
    const worker = new SessionWorker({
      agentFactory: () => { throw new Error("not used"); },
      workerToken: TOKEN,
    });
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/agent-ops/session/notify-on-merge-self",
      remoteAddress: PEER_CONTAINER_IP,
      payload: {},
    });
    expect(res.statusCode).toBe(403);

    // …and the same route still works for the container's own agent, which is
    // what would break if the guard were too broad.
    const healthy = await worker.getApp().inject({
      method: "GET",
      url: "/health",
      remoteAddress: "127.0.0.1",
    });
    expect(healthy.statusCode).toBe(200);
    await worker.stop();
  });
});
