import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPreviewRoutes } from "./api-routes-preview.js";
import type { ApiDeps } from "./api-routes.js";
import type { ManagedService, ServiceManager } from "./service-manager.js";
import type { DependencyGap } from "./dependency-staleness.js";

const SESSION = "s1";

interface FakeManager {
  services: ManagedService[];
  projectComposeFailure: { kind: "refused" | "malformed"; message: string } | null;
}

async function appWith(fake: FakeManager | null, gap: DependencyGap | null = null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const mgr = fake
    ? ({
      getServices: () => fake.services,
      projectComposeFailure: fake.projectComposeFailure,
    } as unknown as ServiceManager)
    : undefined;
  await registerPreviewRoutes(app, {
    sessionManager: { get: () => undefined },
    runnerRegistry: { get: () => (gap ? { dependencyGap: gap } : undefined) },
    serviceManagers: new Map(mgr ? [[SESSION, mgr]] : []),
    broadcastLog: () => {},
  } as unknown as ApiDeps);
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function listServices(fake: FakeManager | null, gap: DependencyGap | null = null): Promise<{
  statusCode: number;
  body: {
    services?: unknown[];
    failure?: { kind: string; message: string };
    dependencies?: { reason: string; message: string };
    error?: string;
  };
}> {
  app = await appWith(fake, gap);
  const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION}/services` });
  return { statusCode: res.statusCode, body: res.json() };
}

describe("GET /api/sessions/:id/services", () => {
  it("states why the list is empty when the project's compose file was refused", async () => {
    const { statusCode, body } = await listServices({
      services: [],
      projectComposeFailure: {
        kind: "refused",
        message: "Service `web`: contained services must declare a numeric, non-root `user:`.",
      },
    });

    expect(statusCode).toBe(200);
    expect(body.services).toEqual([]);
    expect(body.failure).toEqual({
      kind: "refused",
      message: "Service `web`: contained services must declare a numeric, non-root `user:`.",
    });
  });

  it("distinguishes a file it could not parse from one it declined", async () => {
    const { body } = await listServices({
      services: [],
      projectComposeFailure: { kind: "malformed", message: "Compose file is not valid YAML: bad indent" },
    });
    expect(body.failure?.kind).toBe("malformed");
  });

  it("omits `failure` entirely when the compose file parsed", async () => {
    const { statusCode, body } = await listServices({
      services: [
        { name: "web", preview: "auto", status: "running", dependsOnInstall: false, port: 5173 },
      ],
      projectComposeFailure: null,
    });
    expect(statusCode).toBe(200);
    expect(body).not.toHaveProperty("failure");
    expect(body.services).toHaveLength(1);
  });

  it("carries the dependency gap alongside a service that reads as healthy", async () => {
    const { body } = await listServices(
      {
        services: [
          { name: "dev", preview: "auto", status: "running", dependsOnInstall: false, port: 5173 },
        ],
        projectComposeFailure: null,
      },
      { reason: "not-content-keyed", rewrite: "rebase", commands: ["./setup.sh"] },
    );

    expect(body.services).toHaveLength(1);
    expect(body.dependencies?.reason).toBe("not-content-keyed");
    expect(body.dependencies?.message).toContain("a sync onto the latest base");
  });

  it("omits `dependencies` when the installed tree is believed current", async () => {
    const { body } = await listServices({
      services: [
        { name: "web", preview: "auto", status: "running", dependsOnInstall: false, port: 5173 },
      ],
      projectComposeFailure: null,
    });
    expect(body).not.toHaveProperty("dependencies");
  });

  it("still 404s when the session has no compose stack at all", async () => {
    const { statusCode, body } = await listServices(null);
    expect(statusCode).toBe(404);
    expect(body.error).toContain("No compose stack");
  });
});
