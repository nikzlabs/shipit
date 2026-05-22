/**
 * Unit tests for the worker's /agent-ops/* router. These test the broker
 * layer in isolation: the router takes shim-style requests and forwards them
 * to a stubbed orchestrator client. Stubs let us assert the exact path and
 * body the broker forwards without spinning up the orchestrator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerAgentOpsRoutes } from "./agent-ops-routes.js";
import type { OrchestratorClient } from "./orchestrator-client.js";

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

class FakeOrchestratorClient {
  calls: RecordedCall[] = [];
  responses: Record<string, FakeResponse> = {};

  setResponse(method: string, suffix: string, response: FakeResponse): void {
    this.responses[`${method} ${suffix.split("?")[0]}`] = response;
  }

  async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    suffix: string,
    body?: unknown,
  ): Promise<FakeResponse> {
    this.calls.push({ method, path: suffix, body });
    const key = `${method} ${suffix.split("?")[0]}`;
    return this.responses[key] ?? { ok: true, status: 200, body: {} };
  }
}

describe("agent-ops routes", () => {
  let app: FastifyInstance;
  let client: FakeOrchestratorClient;

  beforeEach(() => {
    app = Fastify({ logger: false });
    client = new FakeOrchestratorClient();
    registerAgentOpsRoutes(app, {
      createOrchestratorClient: () => client as unknown as OrchestratorClient,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /agent-ops/pr/create forwards to /pr/agent-create with body", async () => {
    client.setResponse("POST", "/pr/agent-create", {
      ok: true, status: 200,
      body: { number: 1, url: "https://github.com/x/y/pull/1", alreadyExisted: false },
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/pr/create",
      payload: { title: "T", body: "B", draft: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ number: 1, url: "https://github.com/x/y/pull/1" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("POST");
    expect(client.calls[0].path).toBe("/pr/agent-create");
    expect(client.calls[0].body).toMatchObject({ title: "T", body: "B" });
  });

  it("PATCH /agent-ops/pr/:number forwards body and number", async () => {
    client.setResponse("PATCH", "/pr/42", { ok: true, status: 200, body: { url: "u", number: 42 } });

    const res = await app.inject({
      method: "PATCH",
      url: "/agent-ops/pr/42",
      payload: { title: "Updated" },
    });

    expect(res.statusCode).toBe(200);
    expect(client.calls[0].path).toBe("/pr/42");
    expect(client.calls[0].body).toEqual({ title: "Updated" });
  });

  it("GET /agent-ops/pr/status forwards to /pr/status", async () => {
    client.setResponse("GET", "/pr/status", {
      ok: true, status: 200, body: { pr: { number: 5 } },
    });
    const res = await app.inject({ method: "GET", url: "/agent-ops/pr/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pr: { number: 5 } });
  });

  it("GET /agent-ops/pr/view forwards ?number= as querystring", async () => {
    client.setResponse("GET", "/pr/view", {
      ok: true, status: 200, body: { pr: { number: 5 } },
    });
    await app.inject({ method: "GET", url: "/agent-ops/pr/view?number=5" });
    expect(client.calls[0].path).toContain("/pr/view?number=5");
  });

  it("GET /agent-ops/pr/list forwards ?state=", async () => {
    client.setResponse("GET", "/pr/list", { ok: true, status: 200, body: { prs: [] } });
    await app.inject({ method: "GET", url: "/agent-ops/pr/list?state=closed" });
    expect(client.calls[0].path).toContain("/pr/list?state=closed");
  });

  it("POST /agent-ops/pr/:number/comment forwards body", async () => {
    client.setResponse("POST", "/pr/9/comment", {
      ok: true, status: 200, body: { number: 9, commentUrl: "c" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/pr/9/comment",
      payload: { body: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(client.calls[0].path).toBe("/pr/9/comment");
    expect(client.calls[0].body).toEqual({ body: "hello" });
  });

  it("POST /agent-ops/pr/:number/ready forwards", async () => {
    client.setResponse("POST", "/pr/9/ready", { ok: true, status: 200, body: { number: 9 } });
    const res = await app.inject({ method: "POST", url: "/agent-ops/pr/9/ready" });
    expect(res.statusCode).toBe(200);
  });

  it("POST /agent-ops/pr/:number/close forwards", async () => {
    client.setResponse("POST", "/pr/9/close", { ok: true, status: 200, body: { url: "u" } });
    const res = await app.inject({ method: "POST", url: "/agent-ops/pr/9/close" });
    expect(res.statusCode).toBe(200);
  });

  it("POST /agent-ops/pr/:number/reopen forwards", async () => {
    client.setResponse("POST", "/pr/9/reopen", { ok: true, status: 200, body: { url: "u" } });
    const res = await app.inject({ method: "POST", url: "/agent-ops/pr/9/reopen" });
    expect(res.statusCode).toBe(200);
  });

  it("orchestrator error status flows back to the shim", async () => {
    client.setResponse("POST", "/pr/agent-create", {
      ok: false, status: 401, body: { error: "Not authenticated" },
    });
    const res = await app.inject({
      method: "POST", url: "/agent-ops/pr/create", payload: { title: "T" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Not authenticated" });
  });

  // ---- Agent-spawned sessions (docs/117) ----

  it("POST /agent-ops/session/create forwards to /spawn with body", async () => {
    client.setResponse("POST", "/spawn", {
      ok: true, status: 200,
      body: { sessionId: "ses_abc", branch: "port-api-ts", status: "running" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/session/create",
      payload: { prompt: "Port API to TS", branch: "port-api-ts" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: "ses_abc", branch: "port-api-ts" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe("POST");
    expect(client.calls[0].path).toBe("/spawn");
    expect(client.calls[0].body).toMatchObject({ prompt: "Port API to TS", branch: "port-api-ts" });
  });

  it("POST /agent-ops/session/create surfaces a 429 quota error", async () => {
    client.setResponse("POST", "/spawn", {
      ok: false, status: 429,
      body: { error: "Per-turn spawn limit reached" },
    });
    const res = await app.inject({
      method: "POST", url: "/agent-ops/session/create", payload: { prompt: "x" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("Per-turn spawn limit");
  });

  it("GET /agent-ops/session/list forwards to /children", async () => {
    client.setResponse("GET", "/children", {
      ok: true, status: 200,
      body: { children: [{ id: "ses_a", title: "A", status: "running" }] },
    });
    const res = await app.inject({ method: "GET", url: "/agent-ops/session/list" });
    expect(res.statusCode).toBe(200);
    expect(client.calls[0].path).toBe("/children");
    expect((res.json() as { children: unknown[] }).children).toHaveLength(1);
  });

  it("GET /agent-ops/session/list forwards ?turn=", async () => {
    client.setResponse("GET", "/children", {
      ok: true, status: 200, body: { children: [] },
    });
    await app.inject({ method: "GET", url: "/agent-ops/session/list?turn=turn-xyz" });
    expect(client.calls[0].path).toContain("/children?turn=turn-xyz");
  });

  it("GET /agent-ops/session/view/:childId forwards to /children/:childId", async () => {
    client.setResponse("GET", "/children/ses_x", {
      ok: true, status: 200,
      body: { child: { id: "ses_x", title: "T", status: "idle" } },
    });
    const res = await app.inject({ method: "GET", url: "/agent-ops/session/view/ses_x" });
    expect(res.statusCode).toBe(200);
    expect(client.calls[0].path).toBe("/children/ses_x");
    expect((res.json() as { child: { id: string } }).child.id).toBe("ses_x");
  });

  it("GET /agent-ops/session/view/:childId surfaces a 404 verbatim", async () => {
    client.setResponse("GET", "/children/ses_other", {
      ok: false, status: 404, body: { error: "Spawned session not found" },
    });
    const res = await app.inject({ method: "GET", url: "/agent-ops/session/view/ses_other" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Spawned session not found");
  });

  // ---- Agent-spawned sessions: Phase 3 (docs/117) ----

  it("POST /agent-ops/session/message/:childId forwards to /children/:childId/message", async () => {
    client.setResponse("POST", "/children/ses_a/message", {
      ok: true, status: 200,
      body: { queuePosition: 1, enqueued: true },
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/session/message/ses_a",
      payload: { text: "do X" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queuePosition: 1, enqueued: true });
    expect(client.calls[0].method).toBe("POST");
    expect(client.calls[0].path).toBe("/children/ses_a/message");
    expect(client.calls[0].body).toEqual({ text: "do X" });
  });

  it("POST /agent-ops/session/message/:childId surfaces a 404 verbatim", async () => {
    client.setResponse("POST", "/children/ses_other/message", {
      ok: false, status: 404, body: { error: "Spawned session not found" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/session/message/ses_other",
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /agent-ops/session/wait/:childId forwards ?wait=true&timeout=", async () => {
    client.setResponse("GET", "/children/ses_a", {
      ok: true, status: 200,
      body: { child: { id: "ses_a" }, idle: true, timedOut: false },
    });
    await app.inject({ method: "GET", url: "/agent-ops/session/wait/ses_a?timeout=120" });
    expect(client.calls[0].path).toBe("/children/ses_a?wait=true&timeout=120");
  });

  it("GET /agent-ops/session/wait/:childId without timeout still requests wait=true", async () => {
    client.setResponse("GET", "/children/ses_a", {
      ok: true, status: 200,
      body: { child: { id: "ses_a" }, idle: true, timedOut: false },
    });
    await app.inject({ method: "GET", url: "/agent-ops/session/wait/ses_a" });
    expect(client.calls[0].path).toBe("/children/ses_a?wait=true");
  });

  it("POST /agent-ops/session/archive/:childId forwards to /children/:childId/archive", async () => {
    client.setResponse("POST", "/children/ses_a/archive", {
      ok: true, status: 200, body: { archived: true, sessions: [] },
    });
    const res = await app.inject({ method: "POST", url: "/agent-ops/session/archive/ses_a" });
    expect(res.statusCode).toBe(200);
    expect(client.calls[0].method).toBe("POST");
    expect(client.calls[0].path).toBe("/children/ses_a/archive");
    expect(client.calls[0].body).toEqual({});
  });

  it("POST /agent-ops/session/archive/:childId surfaces a 409 (still running) verbatim", async () => {
    client.setResponse("POST", "/children/ses_a/archive", {
      ok: false, status: 409, body: { error: "Cannot archive a running child session" },
    });
    const res = await app.inject({ method: "POST", url: "/agent-ops/session/archive/ses_a" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Cannot archive");
  });

  it("POST /agent-ops/git/credential forwards host/protocol to /git/credential", async () => {
    client.setResponse("POST", "/git/credential", {
      ok: true, status: 200,
      body: { username: "x-access-token", password: "ghp_brokered" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/git/credential",
      payload: { host: "github.com", protocol: "https" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: "x-access-token", password: "ghp_brokered" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: "POST",
      path: "/git/credential",
      body: { host: "github.com", protocol: "https" },
    });
  });

  it("POST /agent-ops/git/credential surfaces a 404 (no credential) verbatim", async () => {
    client.setResponse("POST", "/git/credential", {
      ok: false, status: 404, body: { error: "No credential available for host" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/agent-ops/git/credential",
      payload: { host: "example.com" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("No credential available for host");
  });

  it("returns a 500 with a clear message when the orchestrator client cannot be constructed", async () => {
    const errApp = Fastify({ logger: false });
    registerAgentOpsRoutes(errApp, {
      createOrchestratorClient: () => {
        throw new Error("SHIPIT_HOST not set");
      },
    });
    const res = await errApp.inject({
      method: "POST", url: "/agent-ops/pr/create", payload: { title: "T" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("agent-ops misconfigured");
    expect(res.json().error).toContain("SHIPIT_HOST not set");
    await errApp.close();
  });
});
