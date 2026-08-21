/**
 * planning#313 — the guard as Fastify sees it, plus the end-to-end assertion that
 * `SessionWorker` actually installs it (the part that would silently regress if
 * someone reordered `buildApp`).
 *
 * `app.inject`'s `remoteAddress` stands in for the TCP peer, which is what makes
 * "a request from another session's container" expressible in a unit test.
 */

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

/**
 * Send a hand-written request line over a real socket.
 *
 * `app.inject` builds the request from a parsed URL and normalizes away exactly
 * the spellings the guard has to defend against (a `#` fragment, an absolute
 * request target), so a bypass that a real client can send is invisible to it.
 */
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
/** A plausible peer: another session's agent container on the shared bridge. */
const PEER_CONTAINER_IP = "172.18.0.9";

// NB: `token` is required rather than defaulted — passing an explicit
// `undefined` to a defaulted parameter would silently take the default and the
// "no token configured" case would never actually be exercised.
//
// The guard reads no environment of its own since planning#421 (the container entry
// point does, once, via `requireWorkerToken`), so `token: undefined` here means
// exactly what it says. It used to fall back to `WORKER_TOKEN_ENV` — set in every
// session container — and the no-token branch was silently never reached
// in-container while passing in CI.
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

  it("planning#421: a worker with no token configured refuses every peer container", async () => {
    // The orchestrator-facing leg used to be served here, as a compatibility
    // fallback for a container created by an orchestrator that predates the
    // token. `/install` is the one that matters most: it runs `agent.install`
    // with `shell: true` in the credential-bearing container, and a plugin
    // service can reach that container.
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
    // The other half — the tokenless worker is an in-process test worker, which
    // drives its routes over 127.0.0.1 and must keep working.
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
    // The self-kill shape at the HTTP layer: a stray in-container caller POSTs
    // /agent/start, gets 403 instead of the 409 that arms the orchestrator's
    // persistent-409 recovery, and /agent/kill is out of reach entirely.
    app = buildGuardedApp(TOKEN);
    for (const url of ["/agent/start", "/agent/kill"]) {
      const res = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: {} });
      expect(res.statusCode, url).toBe(403);
    }

    // …while the probe next door stays open, which is what a too-broad
    // `/agent/` prefix would have broken.
    const status = await app.inject({ method: "GET", url: "/agent/status", remoteAddress: "127.0.0.1" });
    expect(status.statusCode).toBe(200);
  });

  it("planning#241: a fragment or absolute-form target cannot reach a lifecycle handler", async () => {
    // MUST use a real socket. `app.inject` normalizes both spellings away, so an
    // inject-based version of this test passes against the broken guard — that
    // is precisely how both vectors survived the first review round.
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
    // Fastify's router decodes before matching, so `/agent/%6bill` reaches the
    // `/agent/kill` handler. A guard comparing the raw URL would see a path it
    // does not recognize and wave it through — the guard has to canonicalize
    // exactly the way the router does.
    app = buildGuardedApp(TOKEN);
    for (const url of ["/agent/%6bill", "/agent/%6Bill", "/%61gent/start", "/agent/%73tart"]) {
      const res = await app.inject({ method: "POST", url, remoteAddress: "127.0.0.1", payload: {} });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("planning#313: a percent-encoded /agent-ops path stays loopback-only too", async () => {
    // Same defect class on the pre-existing prefix rule: `/%61gent-ops/…`
    // decodes to `/agent-ops/…` at the router.
    app = buildGuardedApp(TOKEN);
    // With a VALID token, which is the case the loopback-only rule exists for:
    // without canonicalization this peer reaches the broker, and the raw path
    // would otherwise fall through to the token check and be allowed.
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
    // Canonicalizing must not turn every encoded character into a denial: the
    // present-artifact routes carry encoded ids.
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
    // A tokenless worker keeps serving lifecycle routes over LOOPBACK: in-process
    // tests build a SessionWorker with no token and drive /agent/start over
    // 127.0.0.1. Not a hole since planning#421 — the same worker refuses every
    // caller that is not inside its own network namespace.
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
  // The container half of failing closed. `registerWorkerAuthGuard` refuses
  // remote callers on a tokenless worker; this refuses to have one at all in a
  // container, which is the state nobody wants a worker serving from.
  it("returns the token the orchestrator injected", () => {
    expect(requireWorkerToken({ [WORKER_TOKEN_ENV]: TOKEN })).toBe(TOKEN);
  });

  it("throws when the variable is absent, naming it", () => {
    expect(() => requireWorkerToken({})).toThrow(MissingWorkerTokenError);
    expect(() => requireWorkerToken({})).toThrow(WORKER_TOKEN_ENV);
  });

  it("throws on an EMPTY value rather than holding an unmatchable token", () => {
    // The orchestrator's `workerTokenFromContainerEnv` maps `SHIPIT_WORKER_TOKEN=`
    // to `undefined` and so sends no header. A worker that kept `""` as its
    // expected token would be up and 403ing every orchestrator call — strictly
    // harder to diagnose than a container that refused to start.
    expect(() => requireWorkerToken({ [WORKER_TOKEN_ENV]: "" })).toThrow(MissingWorkerTokenError);
  });
});

describe("the container entry point refuses to serve without a token (planning#421)", () => {
  // The end-to-end half. `requireWorkerToken`'s own tests prove the function
  // throws; only running the module the way the container runs it proves the
  // process actually dies instead of listening — the entry block is a top-level
  // `if (import.meta.url.endsWith(process.argv[1]))`, which no in-process test
  // can enter.
  it("exits non-zero, naming the variable, when SHIPIT_WORKER_TOKEN is absent", () => {
    const entryPoint = fileURLToPath(new URL("./session-worker.ts", import.meta.url));
    // Stripped suite-wide too; rebuilt explicitly here so the test states its
    // own premise rather than inheriting it from `server-test-setup.ts`.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== WORKER_TOKEN_ENV),
    );
    // Exactly the container's Cmd (`container-lifecycle.ts`: node --import tsx <entry>).
    const res = spawnSync(process.execPath, ["--import", "tsx", entryPoint], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(WORKER_TOKEN_ENV);
    expect(res.stderr).toContain("refusing to start");
    // It must not have got as far as binding a port.
    expect(res.stdout).not.toContain("Listening on");
  }, 90_000);
});

describe("SessionWorker installs the guard", () => {
  it("planning#421: a tokenless real worker refuses a peer container's POST /install", async () => {
    // The same rule on the REAL route table rather than a hand-built app.
    // `/install` runs `agent.install` in the credential-bearing container, and a
    // plugin service can reach that container. Before planning#421 this reached
    // the handler (400 — the body is empty on purpose, so the assertion never
    // runs an install either way).
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

  it("planning#241: hands its token to the guard, so lifecycle routes are closed on the real app", async () => {
    // The /agent-ops assertion above passes even with NO token configured
    // (loopback-only needs none), so on its own it does not prove the worker
    // forwards `workerToken` at all. This does: without that wiring the guard is
    // unconfigured and a loopback /agent/kill would be served.
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
    // Derived from the REAL route table rather than a second hand-written list:
    // a new mutating route added to `AgentController` fails here by name instead
    // of shipping unguarded, which a duplicated literal list cannot catch.
    const worker = new SessionWorker({
      agentFactory: () => { throw new Error("not used"); },
      workerToken: TOKEN,
    });
    const app = worker.getApp();
    await app.ready();

    // Parsed FAIL-CLOSED. The obvious version — regex, keep what matches, drop
    // the rest — passes while covering nothing: a constrained route prints a
    // trailing `{"host":"…"}` and misses the anchor, and a wildcard prints as the
    // bare leaf `*`, so both vanish from the census and the assertions below
    // still hold. Anything under /agent/ that does not parse is a failure here,
    // not a silent omission.
    // Indentation carries parenthood: a nested leaf prints as a bare suffix, so
    // `/present-files/:presentId/*` renders as `* (GET, HEAD)` indented under its
    // parent. Track the last top-level path and re-attach children, or a wildcard
    // added under /agent/ would read as an unrelated `*` and vanish.
    const routes: { path: string; methods: string[] }[] = [];
    let currentTop = "";
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = /^(.*?)[├└]── (\S+) \(([A-Z, ]+)\)\s*$/.exec(line);
      if (!m) {
        // Fail CLOSED on anything in the /agent/ space we cannot parse — e.g. a
        // constrained route, which prints a trailing `{"host":"…"}` and misses
        // the anchor. The obvious "regex, keep what matches, drop the rest"
        // version passes while silently covering nothing.
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
        // A wildcard whose parent prefix is not itself a route prints as a bare
        // top-level `*`, with no way to tell which subtree it serves. We cannot
        // certify the /agent/ space while an unattributable route exists, so this
        // fails rather than skipping it — `/agent/blob/*` renders exactly this way.
        throw new Error(
          `Unattributable route in the printed table — cannot tell whether it covers /agent/: ${JSON.stringify(line)}`,
        );
      }
      const path = nested ? currentTop + segment : segment;
      if (!nested) currentTop = segment;
      if (!path.startsWith("/agent/")) continue; // /agent-ops/* is the broker, a different group.
      // LIFECYCLE_PATHS is exact-string membership (`shared/worker-auth.ts`), so a
      // parametric or wildcard route here could never be covered by it — adding
      // `/agent/:id` to the set would turn this green while `/agent/foo` stayed open.
      if (/[:*]/.test(path)) {
        throw new Error(`Parametric/wildcard route in the /agent/ space cannot be guarded by an exact-path set: ${path}`);
      }
      routes.push({ path, methods: (m[3] as string).split(", ") });
    }

    const mutating = routes.filter((r) => r.methods.some((m) => m !== "GET" && m !== "HEAD"));
    expect(mutating.map((r) => r.path).sort()).toEqual([...LIFECYCLE_PATHS].sort());

    // …and the read-only remainder stays out, so the probe keeps working.
    const readOnly = routes.filter((r) => r.methods.every((m) => m === "GET" || m === "HEAD"));
    expect(readOnly.map((r) => r.path)).toEqual(["/agent/status"]);

    await worker.stop();
  });

});
