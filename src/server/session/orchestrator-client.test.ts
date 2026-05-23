import { afterEach, describe, expect, it, vi } from "vitest";
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
      comments: [],
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
});
