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
