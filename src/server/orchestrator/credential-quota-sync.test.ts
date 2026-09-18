import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerBootstrapRoutes } from "./api-routes-bootstrap.js";
import { CredentialStore } from "./credential-store.js";
import { AgentRegistry } from "../shared/agent-registry.js";
import type { ApiDeps } from "./api-routes.js";
import type { LimitsRefreshResult } from "../shared/types.js";

interface RefreshCall {
  modeKey: string;
  reason: string;
  routeId?: string;
}

describe("a supplied credential's quota read-out follows the credential (planning#339)", () => {
  let app: FastifyInstance;
  let dir: string;
  let credentialStore: CredentialStore;
  let refreshes: RefreshCall[];
  let forgets: { modeKey: string; routeId: string }[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zai-quota-sync-"));
    credentialStore = new CredentialStore(dir);
    refreshes = [];
    forgets = [];

    app = Fastify();
    await registerBootstrapRoutes(app, {
      credentialStore,
      agentRegistry: new AgentRegistry(),
      runnerRegistry: { ids: () => [], get: () => undefined },
      sseBroadcast: vi.fn(),
      refreshSubscriptionLimits: vi.fn(async (modeKey: string, reason: string, routeId?: string) => {
        refreshes.push({ modeKey, reason, routeId });
        return [] as LimitsRefreshResult[];
      }),
      forgetSubscriptionLimits: vi.fn((modeKey: string, routeId: string) => {
        forgets.push({ modeKey, routeId });
      }),
    } as unknown as ApiDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function addGlmCredential(secret = "glm-key-1"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "zai", billingMode: "sub", secret },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { route: { id: string } }).route.id;
  }

  it("seeds a baseline when the credential is added", async () => {
    const routeId = await addGlmCredential();
    expect(refreshes).toEqual([{ modeKey: "zai:sub", reason: "seed", routeId }]);
  });

  it("re-reads when the secret is replaced, and does NOT on a rename", async () => {
    const routeId = await addGlmCredential();
    refreshes.length = 0;

    await app.inject({
      method: "PATCH",
      url: `/api/credential-routes/${routeId}`,
      payload: { label: "Work plan" },
    });
    expect(refreshes).toEqual([]);

    await app.inject({
      method: "PATCH",
      url: `/api/credential-routes/${routeId}`,
      payload: { secret: "glm-key-2" },
    });
    expect(refreshes).toEqual([{ modeKey: "zai:sub", reason: "manual", routeId }]);
  });

  it("forgets the cached reading when the credential is removed", async () => {
    const routeId = await addGlmCredential();
    await app.inject({ method: "DELETE", url: `/api/credential-routes/${routeId}` });
    expect(forgets).toEqual([{ modeKey: "zai:sub", routeId }]);
  });

  it("re-reads for the OTHER writer — the agent-env route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/claude/env",
      payload: { key: "ZAI_CODING_PLAN_KEY", value: "glm-key-3" },
    });
    expect(res.statusCode).toBe(200);

    const stored = credentialStore.listCredentialRoutes("zai", "sub");
    expect(stored).toHaveLength(1);
    expect(refreshes).toEqual([{ modeKey: "zai:sub", reason: "manual", routeId: stored[0]!.id }]);
  });

  it("says nothing about a key mode, which has no allowance to report", async () => {
    await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "deepseek", billingMode: "key", secret: "ds-key" },
    });
    expect(refreshes).toEqual([]);
    expect(forgets).toEqual([]);
  });
});
