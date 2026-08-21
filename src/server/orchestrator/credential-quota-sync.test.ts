/**
 * planning#339 — **a string-delivered subscription's quota read-out follows the
 * credential behind it**, at every place a credential is written.
 *
 * An account-backed subscription gets this for free: signing in seeds a
 * baseline (`bootstrap-managers.ts`) and signing out clears the cache. A pasted
 * secret has neither event, so the two moments have to be named at each writer
 * — and there are two writers, which is the part that is easy to get half
 * right. `POST /api/credential-routes` is the Services surface; `POST
 * /api/agents/:id/env` is onboarding, the Codex tab and the dogfood seeder, and
 * it reaches the same store through `upsertSingleStringCredential`.
 *
 * These are guard tests rather than behaviour tests: each hook is one line at a
 * call site, and the failure when one is missing is silent — a GLM pill showing
 * a number for a key that was replaced an hour ago, or one showing a number for
 * a credential the user removed.
 */

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
    // Nothing pushes GLM's numbers during a turn, so without this the pill sits
    // empty until the user happens to press refresh.
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
    // `manual`, not `seed`: a replaced secret is a DIFFERENT credential wearing
    // the same route id, so the cached reading describes a key that is gone and
    // a seed — which self-skips once a reading exists — would leave it there.
    expect(refreshes).toEqual([{ modeKey: "zai:sub", reason: "manual", routeId }]);
  });

  it("forgets the cached reading when the credential is removed", async () => {
    const routeId = await addGlmCredential();
    await app.inject({ method: "DELETE", url: `/api/credential-routes/${routeId}` });
    expect(forgets).toEqual([{ modeKey: "zai:sub", routeId }]);
  });

  it("re-reads for the OTHER writer — the agent-env route", async () => {
    // `POST /api/agents/:id/env` routes a catalogue `storageEnv` name into the
    // same credential store (docs/252 phase 2). A reader seeded only from the
    // Services surface shows nothing for a key written through onboarding.
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
    // req 10 keeps that slot empty rather than filling it with a placeholder,
    // so there is no read-out to seed and no upstream call to spend.
    await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "deepseek", billingMode: "key", secret: "ds-key" },
    });
    expect(refreshes).toEqual([]);
    expect(forgets).toEqual([]);
  });
});
