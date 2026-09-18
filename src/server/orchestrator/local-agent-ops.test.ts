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

  it("maps the plugin routes the `shipit plugin` shim emits", () => {
    expect(mapAgentOpsPath("/agent-ops/plugin/refresh")).toBe("plugin/refresh");
    expect(mapAgentOpsPath("/agent-ops/plugin/exec")).toBe("plugin/exec");
  });

  it("still denies the CI verbs the shim never emits", () => {
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

  it("accepts every /agent-ops path the gh shim can emit", () => {
    const source = fs.readFileSync(GH_SHIM, "utf8");
    // Only literal call sites are checked; paths assembled in variables are invisible.
    const raw = [...source.matchAll(/deps\.call\(\s*"[A-Z]+",\s*([`"])([^`"]*)\1/g)]
      .map((m) => m[2]);
    expect(raw.length).toBeGreaterThan(8);
    expect(raw.every((p) => p.startsWith("/agent-ops/"))).toBe(true);

    // Assembled at runtime: a literal "${op}" trips no-template-curly-in-string.
    const OP_HOLE = ["$", "{op}"].join("");

    const concrete = new Set<string>();
    for (const entry of raw) {
      const withNum = entry.replace(/\$\{num\}/g, "7");
      const expansions = withNum.includes(OP_HOLE)
        ? ["ready", "close", "reopen"].map((op) => withNum.replace(/\$\{op\}/g, op))
        : [withNum];
      for (const e of expansions) concrete.add(e.replace(/\$\{[^}]*\}/g, ""));
    }

    const denied = [...concrete].filter((p) => mapAgentOpsPath(p) === null);
    expect(denied, `gh shim emits paths this host denies: ${denied.join(", ")}`).toEqual([]);
  });

  it("accepts every /agent-ops path the `shipit plugin` shim can emit", () => {
    const source = fs.readFileSync(PLUGIN_SHIM, "utf8");
    const raw = [...source.matchAll(/deps\.call\(\s*"[A-Z]+",\s*([`"])([^`"]*)\1/g)]
      .map((m) => m[2].replace(/\$\{[^}]*\}/g, "").split("?")[0]);
    expect(raw.length).toBeGreaterThan(2);
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
    // Port 0 cannot be reused by another test after a listener closes.
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
