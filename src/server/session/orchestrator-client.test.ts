import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  OrchestratorClient,
  resolveOrchestratorBaseUrl,
  resolveOrchestratorBaseUrls,
} from "./orchestrator-client.js";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("resolveOrchestratorBaseUrls", () => {
  it("returns the configured host followed by stable fallback hosts", () => {
    process.env.SHIPIT_HOST = "old-container-id";
    process.env.SHIPIT_PORT = "4123";
    process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = "shipit,shipit";

    expect(resolveOrchestratorBaseUrl()).toBe("http://old-container-id:4123");
    expect(resolveOrchestratorBaseUrls()).toEqual([
      "http://old-container-id:4123",
      "http://shipit:4123",
    ]);
  });

  it("returns no URLs when the orchestrator env is missing", () => {
    delete process.env.SHIPIT_HOST;
    delete process.env.SHIPIT_PORT;

    expect(resolveOrchestratorBaseUrl()).toBeNull();
    expect(resolveOrchestratorBaseUrls()).toEqual([]);
  });
});

describe("OrchestratorClient", () => {
  it("falls back to the stable Docker alias when the stamped hostname is stale", async () => {
    process.env.SHIPIT_HOST = "stale-container-id";
    process.env.SHIPIT_PORT = "4123";
    process.env.SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS = "shipit";
    process.env.SESSION_ID = "sess-1";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = new OrchestratorClient();
    const res = await client.request("POST", "/review-submit", {
      filePath: "docs/plan.md",
      markdown: "No material issues found.",
    });

    expect(res).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://stale-container-id:4123/api/sessions/sess-1/review-submit",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://shipit:4123/api/sessions/sess-1/review-submit",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Regression: the `shipit agent run` spawn relay passes `{ timeoutMs: 0 }`
  // (unbounded). It must NOT use the global `fetch` (undici), whose default 300s
  // headersTimeout would abort a long sub-agent consult with "fetch failed".
  describe("unbounded relay (timeoutMs: 0)", () => {
    it("round-trips a JSON body over Node http without touching global fetch", async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", () => {
          const prompt = (JSON.parse(body || "{}") as { prompt?: string }).prompt;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ echoedPrompt: prompt, status: "success" }));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        process.env.SESSION_ID = "sess-1";
        const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}` });
        const res = await client.request("POST", "/agent/spawn", { prompt: "review this" }, { timeoutMs: 0 });

        expect(res).toEqual({ ok: true, status: 200, body: { echoedPrompt: "review this", status: "success" } });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it("surfaces a downstream 4xx body verbatim (status preserved, not collapsed to 0)", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Sub-agents are disabled." }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;

      try {
        process.env.SESSION_ID = "sess-1";
        const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}` });
        const res = await client.request("POST", "/agent/spawn", { prompt: "x" }, { timeoutMs: 0 });

        expect(res).toEqual({ ok: false, status: 403, body: { error: "Sub-agents are disabled." } });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it("returns status 0 with an aggregated error when the orchestrator is unreachable", async () => {
      // A closed port → ECONNREFUSED on the Node-http transport → the fallback
      // loop exhausts and reports status 0 (not a thrown exception).
      process.env.SESSION_ID = "sess-1";
      const client = new OrchestratorClient({ baseUrl: "http://127.0.0.1:1" });
      const res = await client.request("POST", "/agent/spawn", { prompt: "x" }, { timeoutMs: 0 });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect((res.body as { error: string }).error).toContain("Could not reach orchestrator");
    });
  });
});
