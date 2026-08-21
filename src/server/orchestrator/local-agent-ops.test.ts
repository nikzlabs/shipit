/**
 * The `/agent-ops` host that makes `gh` work in the dogfood (docs/251).
 *
 * The drift guard below is the important one: this module reimplements the
 * worker router's path mapping because the layer boundary forbids importing it
 * (see the module docstring), and reimplemented mappings rot silently. Reading
 * the shim's own source and asserting every path it can emit is accepted here
 * turns "a new `gh` subcommand 403s in the dogfood" into a failing build.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  ensureLocalAgentOpsHost,
  localAgentOpsSpawnEnv,
  localOrchestratorBaseUrl,
  mapAgentOpsPath,
  resetLocalAgentOpsForTests,
  startLocalAgentOpsHost,
  stopLocalAgentOpsHost,
} from "./local-agent-ops.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GH_SHIM = path.resolve(HERE, "../session/agent-shim/gh.ts");
const PLUGIN_SHIM = path.resolve(HERE, "../session/agent-shim/shipit-plugin.ts");

describe("mapAgentOpsPath", () => {
  it("maps the fixed PR routes, including the worker's rename of pr/create", () => {
    expect(mapAgentOpsPath("/agent-ops/pr/create")).toBe("pr/agent-create");
    expect(mapAgentOpsPath("/agent-ops/pr/view")).toBe("pr/view");
    expect(mapAgentOpsPath("/agent-ops/pr/list")).toBe("pr/list");
    expect(mapAgentOpsPath("/agent-ops/pr/status")).toBe("pr/status");
  });

  it("maps the Actions routes onto their /actions/* names", () => {
    expect(mapAgentOpsPath("/agent-ops/run/list")).toBe("actions/runs");
    expect(mapAgentOpsPath("/agent-ops/run/view")).toBe("actions/runs/view");
    expect(mapAgentOpsPath("/agent-ops/run/rerun")).toBe("actions/runs/rerun");
    expect(mapAgentOpsPath("/agent-ops/workflow/list")).toBe("actions/workflows");
    expect(mapAgentOpsPath("/agent-ops/workflow/view")).toBe("actions/workflows/view");
  });

  // docs/262 req 12 — the dogfood instance has no container, so this host IS
  // the agent-ops surface there. A missing entry means `shipit plugin refresh`
  // works in production and is denied in the inner instance, which is exactly
  // the drift this allowlist keeps making visible.
  it("maps the plugin routes the `shipit plugin` shim emits", () => {
    expect(mapAgentOpsPath("/agent-ops/plugin/refresh")).toBe("plugin/refresh");
    expect(mapAgentOpsPath("/agent-ops/plugin/exec")).toBe("plugin/exec");
  });

  it("still denies the CI verbs the shim never emits", () => {
    // `rerun` was unbundled from these three deliberately — dispatch chooses new
    // workflow content, cancel/delete destroy state. Nothing here should map.
    expect(mapAgentOpsPath("/agent-ops/run/cancel")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/run/delete")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/workflow/run")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/workflow/dispatch")).toBeNull();
  });

  it("maps the numbered PR edit and per-PR operations", () => {
    expect(mapAgentOpsPath("/agent-ops/pr/42")).toBe("pr/42");
    for (const op of ["comment", "ready", "close", "reopen", "merge"]) {
      expect(mapAgentOpsPath(`/agent-ops/pr/42/${op}`)).toBe(`pr/42/${op}`);
    }
  });

  it("denies anything the gh shim never emits", () => {
    // The allowlist is the security boundary — absence must be a deny, not a
    // pass-through, or the agent reaches more than the worker's own surface.
    expect(mapAgentOpsPath("/agent-ops/voice/note")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/present/submit")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/session/create")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/pr/42/delete")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/pr/notanumber/merge")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/")).toBeNull();
  });

  it("does not let a traversal segment escape the session scope", () => {
    expect(mapAgentOpsPath("/agent-ops/../sessions/other/pr/status")).toBeNull();
    expect(mapAgentOpsPath("/agent-ops/pr/../../admin")).toBeNull();
  });

  // ---- drift guard -------------------------------------------------------
  it("accepts every /agent-ops path the gh shim can emit", () => {
    const source = fs.readFileSync(GH_SHIM, "utf8");
    // Only real call sites — `deps.call("<METHOD>", "<path>"…)`. Matching bare
    // `/agent-ops/…` anywhere would scrape the file's prose too.
    const raw = [...source.matchAll(/deps\.call\(\s*"[A-Z]+",\s*([`"])([^`"]*)\1/g)]
      .map((m) => m[2]);
    expect(raw.length).toBeGreaterThan(8); // sanity: we actually found them
    expect(raw.every((p) => p.startsWith("/agent-ops/"))).toBe(true);

    // Assembled at runtime: a literal "${op}" trips no-template-curly-in-string.
    const OP_HOLE = ["$", "{op}"].join("");

    const concrete = new Set<string>();
    for (const entry of raw) {
      // `${num}` is a PR number; `${op}` expands over the ops the shim passes
      // through; anything else interpolated is a trailing querystring.
      const withNum = entry.replace(/\$\{num\}/g, "7");
      const expansions = withNum.includes(OP_HOLE)
        ? ["ready", "close", "reopen"].map((op) => withNum.replace(/\$\{op\}/g, op))
        : [withNum];
      for (const e of expansions) concrete.add(e.replace(/\$\{[^}]*\}/g, ""));
    }

    const denied = [...concrete].filter((p) => mapAgentOpsPath(p) === null);
    expect(denied, `gh shim emits paths this host denies: ${denied.join(", ")}`).toEqual([]);
  });

  // docs/262 — the same guard for the `shipit plugin` verb, and ONLY that verb.
  // Scoping matters: the `shipit` shim as a whole emits agent-ops paths this
  // host deliberately denies (`shipit service` needs a ServiceManager local mode
  // does not have, `shipit agent run` spawns a sub-agent), so scanning
  // `shipit.ts` would assert a parity that is not wanted. `shipit-plugin.ts` is
  // the file whose every path local mode MUST admit — reqs 12 and 17 are
  // orchestrator-side verbs, so denying one here would be dogfood-only drift
  // rather than an honest local-mode limit. A third plugin verb added to that
  // file now fails this build instead of 403-ing in the inner instance.
  it("accepts every /agent-ops path the `shipit plugin` shim can emit", () => {
    const source = fs.readFileSync(PLUGIN_SHIM, "utf8");
    // Known limit, stated rather than implied (review finding): this captures a
    // LITERAL method and a LITERAL path. A path held in a variable, or built by
    // a helper, is invisible to it — and the count check below would still
    // pass. All of today's calls are literals, so the guard is real now; a
    // future verb that is not would need this widened, not trusted.
    //
    // docs/266 widened it once, as that comment anticipated: `status` appends a
    // querystring, so a trailing `${...}` is dropped and everything from `?` on
    // is cut — which is exactly what the relay does before mapping
    // (`request.url.split("?")[0]`). The PATH is what this asserts; the query
    // never reaches the allowlist.
    const raw = [...source.matchAll(/deps\.call\(\s*"[A-Z]+",\s*([`"])([^`"]*)\1/g)]
      .map((m) => m[2].replace(/\$\{[^}]*\}/g, "").split("?")[0]);
    expect(raw.length).toBeGreaterThan(2); // sanity: refresh + exec + status
    expect(raw.every((p) => p.startsWith("/agent-ops/plugin/"))).toBe(true);

    const denied = raw.filter((p) => mapAgentOpsPath(p) === null);
    expect(
      denied,
      `\`shipit plugin\` emits paths this host denies: ${denied.join(", ")}`,
    ).toEqual([]);
  });
});

describe("localOrchestratorBaseUrl", () => {
  const original = process.env.PORT;
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(process.env, "PORT");
    else process.env.PORT = original;
  });

  it("follows PORT, matching how containers are told where the orchestrator is", () => {
    process.env.PORT = "4000";
    expect(localOrchestratorBaseUrl()).toBe("http://127.0.0.1:4000");
  });

  it("defaults to 3000", () => {
    Reflect.deleteProperty(process.env, "PORT");
    expect(localOrchestratorBaseUrl()).toBe("http://127.0.0.1:3000");
  });
});

describe("the host", () => {
  let orch: FastifyInstance;
  let orchUrl: string;
  let seen: { method: string; url: string; body: unknown }[];

  beforeEach(async () => {
    seen = [];
    orch = Fastify({ logger: false });
    orch.all("/api/sessions/:id/*", async (request, reply) => {
      seen.push({ method: request.method, url: request.url, body: request.body });
      return reply.code(200).send({ ok: true, saw: request.url });
    });
    await orch.listen({ host: "127.0.0.1", port: 0 });
    const addr = orch.server.address();
    orchUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await resetLocalAgentOpsForTests();
    await orch.close();
    vi.restoreAllMocks();
  });

  it("injects its own session id — the agent cannot name another session", async () => {
    const host = await startLocalAgentOpsHost({ sessionId: "sess-a", orchestratorBaseUrl: orchUrl });
    const res = await fetch(`${host.url}/agent-ops/pr/status`);

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The session is a property of the listener, so it is the same regardless
    // of what the caller asked for.
    expect(seen[0].url).toBe("/api/sessions/sess-a/pr/status");
    await host.close();
  });

  it("forwards the body and rewrites pr/create to the agent-create route", async () => {
    const host = await startLocalAgentOpsHost({ sessionId: "s1", orchestratorBaseUrl: orchUrl });
    const res = await fetch(`${host.url}/agent-ops/pr/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "T", body: "B" }),
    });

    expect(res.status).toBe(200);
    expect(seen[0].url).toBe("/api/sessions/s1/pr/agent-create");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toEqual({ title: "T", body: "B" });
    await host.close();
  });

  it("preserves the querystring", async () => {
    const host = await startLocalAgentOpsHost({ sessionId: "s1", orchestratorBaseUrl: orchUrl });
    await fetch(`${host.url}/agent-ops/pr/view?number=12&repo=o%2Fr`);
    expect(seen[0].url).toBe("/api/sessions/s1/pr/view?number=12&repo=o%2Fr");
    await host.close();
  });

  it("refuses a path outside the allowlist without calling the orchestrator", async () => {
    const host = await startLocalAgentOpsHost({ sessionId: "s1", orchestratorBaseUrl: orchUrl });
    const res = await fetch(`${host.url}/agent-ops/voice/note`, { method: "POST" });

    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
    await host.close();
  });

  it("names the reason when the orchestrator is unreachable", async () => {
    // Requirement 4 (docs/251-local-agent-ops): a transport failure must not read as an
    // outcome.
    //
    // The unreachable base is port 0, NOT this suite's own orchestrator closed
    // mid-test. Closing it released an EPHEMERAL port, and the kernel is free
    // to hand that number to any of the several hundred other test files
    // binding `port: 0` in the same run — so the relay's request could connect
    // to a stranger and be answered. It was: CI saw a 404 here, which this
    // host can only produce by RELAYING it (its own failures are 403 for an
    // unmapped path and 502 for a transport error), so the connection had
    // succeeded against something that was not an orchestrator. Port 0 cannot
    // be hijacked that way, because "listen on port 0" means "pick a real port"
    // — nothing is ever bound to it, so the connect refuses by construction.
    const host = await startLocalAgentOpsHost({
      sessionId: "s1",
      orchestratorBaseUrl: "http://127.0.0.1:0",
    });
    const res = await fetch(`${host.url}/agent-ops/pr/status`);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("Could not reach");
    await host.close();
  });
});

describe("the per-session registry", () => {
  afterEach(async () => {
    await resetLocalAgentOpsForTests();
    vi.restoreAllMocks();
  });

  it("starts one host per session and reuses it across turns", async () => {
    const first = await ensureLocalAgentOpsHost({ sessionId: "s1" });
    const second = await ensureLocalAgentOpsHost({ sessionId: "s1" });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("is single-flight — concurrent turns do not start two listeners", async () => {
    const [a, b, c] = await Promise.all([
      ensureLocalAgentOpsHost({ sessionId: "s1" }),
      ensureLocalAgentOpsHost({ sessionId: "s1" }),
      ensureLocalAgentOpsHost({ sessionId: "s1" }),
    ]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("gives different sessions different hosts", async () => {
    const a = await ensureLocalAgentOpsHost({ sessionId: "s1" });
    const b = await ensureLocalAgentOpsHost({ sessionId: "s2" });
    expect(a).not.toBe(b);
  });

  it("exposes the URL to the spawn env only once the host exists", async () => {
    expect(localAgentOpsSpawnEnv("s1")).toEqual({});
    const url = await ensureLocalAgentOpsHost({ sessionId: "s1" });
    expect(localAgentOpsSpawnEnv("s1")).toEqual({ SHIPIT_AGENT_OPS_URL: url });
  });

  it("drops the session's entry when the runner is disposed", async () => {
    await ensureLocalAgentOpsHost({ sessionId: "s1" });
    await stopLocalAgentOpsHost("s1");
    expect(localAgentOpsSpawnEnv("s1")).toEqual({});
    await expect(stopLocalAgentOpsHost("s1")).resolves.toBeUndefined();
  });
});
