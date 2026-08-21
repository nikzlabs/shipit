/**
 * `GET /api/sessions/:id/services` — the route a docs/262 end-to-end operator
 * read when they reported "`/services` returned `[]` with no error"
 * (planning#382).
 *
 * They were reading the right surface; it was the silent one. A compose file
 * ShipIt DECLINES — docs/263's containment rules decline a stock one, so this
 * is a first-run answer rather than an edge case — produced an empty service
 * map, and the route published that map and nothing else. The reason existed
 * (it reaches the Preview pane as `compose_error`), so the two surfaces
 * disagreed in the misleading direction: one said "refused, here is the line to
 * add", the other said what reads as "nothing is declared".
 *
 * The route is registered against a bare Fastify app with a fake manager,
 * because what is being pinned is the RESPONSE SHAPE, not the manager.
 */

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
    // nikzlabs/shipit#2429 — the dependency gap is a fact about the session's
    // INSTALL, so it is sourced from the runner rather than the manager.
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

    // Still a 200 with a list: an empty list is a valid answer, and the caller
    // gets both facts rather than having to infer one from a status code.
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

  /**
   * nikzlabs/shipit#2429 — the same argument as `failure`, one layer down. A service
   * row that reads `running` is exactly the case the reporter hit: the service
   * was up and every request it served failed on an unresolvable import,
   * because ShipIt had rebased the tree under a `node_modules` it did not
   * re-install.
   */
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
    // Rendered prose, not the raw label — the consumer is an agent shim that
    // prints it verbatim, so the orchestrator owns the wording.
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
