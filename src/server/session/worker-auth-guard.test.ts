
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  MissingWorkerTokenError,
  registerWorkerAuthGuard,
  requireWorkerToken,
} from "./worker-auth-guard.js";
import { SessionWorker } from "./session-worker.js";
import { LIFECYCLE_PATHS, WORKER_AUTH_HEADER, WORKER_TOKEN_ENV } from "../shared/worker-auth.js";

const TOKEN = "b".repeat(64);

// app.inject normalizes fragments and absolute targets before the guard sees them.
function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("close", () => resolve(buf));
    sock.on("error", (err) => resolve(`SOCKET_ERROR ${err.message}`));
  });
}
const PEER_CONTAINER_IP = "172.18.0.9";

// Do not default token: undefined must exercise the tokenless policy.
function buildGuardedApp(token: string | undefined): FastifyInstance {
  const app = Fastify({ logger: false });
  registerWorkerAuthGuard(app, { token, log: () => {} });
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/agent-ops/voice/note", async () => ({ brokered: true }));
  app.get("/present-files/:id", async () => ({ artifact: true }));
  app.post("/terminal/start", async () => ({ started: true }));
  app.post("/install", async () => ({ installed: true }));
  app.get("/present/:id/raw", async () => ({ raw: true }));
  app.post("/agent/start", async () => ({ started: true }));
  app.post("/agent/kill", async () => ({ killed: true }));
  app.get("/agent/status", async () => ({ running: false }));
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
      remoteAddress: "172.18.0.2",
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

  it("planning#421: a worker with no token configured refuses every peer container", async () => {
    app = buildGuardedApp(undefined);
    for (const url of ["/agent-ops/voice/note", "/terminal/start", "/install"]) {
      const res = await app.inject({
        method: "POST",
        url,
        remoteAddress: PEER_CONTAINER_IP,
        payload: {},
      });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("planning#421: a worker with no token serves its own agent over loopback", async () => {
    app = buildGuardedApp(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/terminal/start",
      remoteAddress: "127.0.0.1",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("planning#241: refuses the container's own agent on the lifecycle routes", async () => {
    app = buildGuardedApp(TOKEN);
    for (const url of ["/agent/start", "/agent/kill"]) {
      const res = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: {} });
      expect(res.statusCode, url).toBe(403);
    }

    const status = await app.inject({ method: "GET", url: "/agent/status", remoteAddress: "127.0.0.1" });
    expect(status.statusCode).toBe(200);
  });

  it("planning#241: a fragment or absolute-form target cannot reach a lifecycle handler", async () => {
    const app2 = buildGuardedApp(TOKEN);
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const port = (app2.server.address() as AddressInfo).port;
    try {
      for (const target of [
        "/agent/kill#x",
        "/agent/start#x",
        "/agent/%6bill#x",
        `http://127.0.0.1:${port}/agent/kill`,
        `http://127.0.0.1:${port}/agent/start`,
      ]) {
        const res = await rawRequest(port, `POST ${target} HTTP/1.1`);
        expect(res, target).toContain("403");
        expect(res, target).not.toContain("killed");
        expect(res, target).not.toContain("started");
      }
    } finally {
      await app2.close();
    }
  });

  it("planning#241: a percent-encoded lifecycle path cannot slip past the guard", async () => {
    app = buildGuardedApp(TOKEN);
    for (const url of ["/agent/%6bill", "/agent/%6Bill", "/%61gent/start", "/agent/%73tart"]) {
      const res = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("planning#313: a percent-encoded /agent-ops path stays loopback-only too", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/%61gent-ops/voice/note",
      remoteAddress: PEER_CONTAINER_IP,
      headers: { [WORKER_AUTH_HEADER]: TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves an ordinary path containing a legitimately encoded segment", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "GET",
      url: "/present-files/a%20b",
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("planning#241: serves the orchestrator's lifecycle calls with the token", async () => {
    app = buildGuardedApp(TOKEN);
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      remoteAddress: "172.18.0.2",
      headers: { [WORKER_AUTH_HEADER]: TOKEN },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ started: true });
  });

  it("planning#241: an unconfigured worker still serves lifecycle routes over loopback", async () => {
    app = buildGuardedApp(undefined);
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      remoteAddress: "127.0.0.1",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
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

describe("requireWorkerToken (planning#421)", () => {
  it("returns the token the orchestrator injected", () => {
    expect(requireWorkerToken({ [WORKER_TOKEN_ENV]: TOKEN })).toBe(TOKEN);
  });

  it("throws when the variable is absent, naming it", () => {
    expect(() => requireWorkerToken({})).toThrow(MissingWorkerTokenError);
    expect(() => requireWorkerToken({})).toThrow(WORKER_TOKEN_ENV);
  });

  it("throws on an EMPTY value rather than holding an unmatchable token", () => {
    expect(() => requireWorkerToken({ [WORKER_TOKEN_ENV]: "" })).toThrow(MissingWorkerTokenError);
  });
});

describe("the container entry point refuses to serve without a token (planning#421)", () => {
  it("exits non-zero, naming the variable, when SHIPIT_WORKER_TOKEN is absent", () => {
    const entryPoint = fileURLToPath(new URL("./session-worker.ts", import.meta.url));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== WORKER_TOKEN_ENV),
    );
    const res = spawnSync(process.execPath, ["--import", "tsx", entryPoint], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(WORKER_TOKEN_ENV);
    expect(res.stderr).toContain("refusing to start");
    expect(res.stdout).not.toContain("Listening on");
  }, 90_000);
});

describe("SessionWorker installs the guard", () => {
  it("planning#421: a tokenless real worker refuses a peer container's POST /install", async () => {
    const worker = new SessionWorker({
      agentFactory: () => { throw new Error("not used"); },
    });
    const res = await worker.getApp().inject({
      method: "POST",
      url: "/install",
      remoteAddress: PEER_CONTAINER_IP,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await worker.stop();
  });

  it("403s a peer container's /agent-ops request on the real worker app", async () => {
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

    const healthy = await worker.getApp().inject({
      method: "GET",
      url: "/health",
      remoteAddress: "127.0.0.1",
    });
    expect(healthy.statusCode).toBe(200);
    await worker.stop();
  });

  it("planning#241: hands its token to the guard, so lifecycle routes are closed on the real app", async () => {
    const worker = new SessionWorker({
      agentFactory: () => { throw new Error("not used"); },
      workerToken: TOKEN,
    });
    const killed = await worker.getApp().inject({
      method: "POST",
      url: "/agent/kill",
      remoteAddress: "127.0.0.1",
      payload: {},
    });
    expect(killed.statusCode).toBe(403);

    const status = await worker.getApp().inject({
      method: "GET",
      url: "/agent/status",
      remoteAddress: "127.0.0.1",
    });
    expect(status.statusCode).toBe(200);
    await worker.stop();
  });

  it("planning#241: every mutating /agent/* route the worker registers is in LIFECYCLE_PATHS", async () => {
    const worker = new SessionWorker({
      agentFactory: () => { throw new Error("not used"); },
      workerToken: TOKEN,
    });
    const app = worker.getApp();
    await app.ready();

    // Preserve parent paths from indentation; reject routes the inventory cannot parse.
    const routes: { path: string; methods: string[] }[] = [];
    let currentTop = "";
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = /^(.*?)[├└]── (\S+) \(([A-Z, ]+)\)\s*$/.exec(line);
      if (!m) {
        if (line.includes("/agent/")) {
          throw new Error(
            `Unparsed route line in the /agent/ space — the census cannot see it, so it would ` +
            `ship unguarded. Fix the parse (or the route): ${JSON.stringify(line)}`,
          );
        }
        continue;
      }
      const nested = (m[1] ?? "").trim() !== "";
      const segment = m[2] as string;
      if (!nested && !segment.startsWith("/")) {
        throw new Error(
          `Unattributable route in the printed table — cannot tell whether it covers /agent/: ${JSON.stringify(line)}`,
        );
      }
      const path = nested ? currentTop + segment : segment;
      if (!nested) currentTop = segment;
      if (!path.startsWith("/agent/")) continue;
      // Exact-path membership cannot protect parameter or wildcard routes.
      if (/[:*]/.test(path)) {
        throw new Error(`Parametric/wildcard route in the /agent/ space cannot be guarded by an exact-path set: ${path}`);
      }
      routes.push({ path, methods: (m[3] as string).split(", ") });
    }

    const mutating = routes.filter((r) => r.methods.some((m) => m !== "GET" && m !== "HEAD"));
    expect(mutating.map((r) => r.path).sort()).toEqual([...LIFECYCLE_PATHS].sort());

    const readOnly = routes.filter((r) => r.methods.every((m) => m === "GET" || m === "HEAD"));
    expect(readOnly.map((r) => r.path)).toEqual(["/agent/status"]);

    await worker.stop();
  });

});
