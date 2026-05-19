import { describe, it, expect, vi } from "vitest";
import { ClaudeLimitsProvider, parseClaudeUsage } from "./claude-limits.js";
import type { AuthManager } from "../auth.js";

function makeAuthStub(
  result: Awaited<ReturnType<AuthManager["getAccessToken"]>>,
): Pick<AuthManager, "getAccessToken"> {
  return { getAccessToken: vi.fn().mockResolvedValue(result) };
}

describe("parseClaudeUsage", () => {
  it("parses fraction-shaped utilization (0..1) into percentage", () => {
    const result = parseClaudeUsage(
      {
        subscription: "Max 20x",
        five_hour: { utilization: 0.96, resets_at: "2026-05-19T18:00:00Z" },
        seven_day: { utilization: 0.22, resets_at: "2026-05-26T00:00:00Z" },
      },
      1_000,
    );
    expect(result?.plan).toBe("Max 20x");
    expect(result?.session?.usedPct).toBeCloseTo(96, 5);
    expect(result?.weekly?.usedPct).toBeCloseTo(22, 5);
  });

  it("parses 0..100 percentage shapes", () => {
    const result = parseClaudeUsage(
      {
        plan: "Pro",
        session: { used_pct: 50, resetAt: "2026-05-19T18:00:00Z" },
        weekly: { used_pct: 25, resetAt: "2026-05-26T00:00:00Z" },
      },
      0,
    );
    expect(result?.session?.usedPct).toBe(50);
    expect(result?.weekly?.usedPct).toBe(25);
  });

  it("clamps over-100 percentages defensively", () => {
    const result = parseClaudeUsage(
      {
        session: { utilization: 120, resets_at: "2026-05-19T18:00:00Z" },
      },
      0,
    );
    expect(result?.session?.usedPct).toBe(100);
  });

  it("returns null when no recognizable window is present", () => {
    expect(parseClaudeUsage({ unknown: "shape" }, 0)).toBeNull();
    expect(parseClaudeUsage(null, 0)).toBeNull();
    expect(parseClaudeUsage("string", 0)).toBeNull();
  });

  it("preserves weeklyOpus when present", () => {
    const result = parseClaudeUsage(
      {
        seven_day: { used_pct: 30, resets_at: "2026-05-26T00:00:00Z" },
        seven_day_opus: { used_pct: 80, resets_at: "2026-05-26T00:00:00Z" },
      },
      0,
    );
    expect(result?.weeklyOpus?.usedPct).toBe(80);
  });
});

describe("ClaudeLimitsProvider", () => {
  it("returns null when no token is available", async () => {
    const auth = makeAuthStub({ token: null, reason: "not-authenticated" });
    const fetchImpl = vi.fn();
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.canFetch()).toBe(false);
  });

  it("returns an auth-expired snapshot on 401", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl, now: () => 1_000 });
    const result = await provider.fetch();
    expect(result?.error).toBe("auth expired");
    expect(result?.fetchedAt).toBe(1_000);
  });

  it("returns an unavailable snapshot on 5xx", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("oops", { status: 503 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result?.error).toBe("limits unavailable");
  });

  it("returns rate-limited snapshot on 429", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 429 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result?.error).toBe("rate limited");
  });

  it("returns a parsed snapshot on a well-formed 200", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const body = {
      subscription: "Pro",
      five_hour: { utilization: 0.3, resets_at: "2026-05-19T18:00:00Z" },
      seven_day: { utilization: 0.1, resets_at: "2026-05-26T00:00:00Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl, now: () => 42 });
    const result = await provider.fetch();
    expect(result).toMatchObject({
      agentId: "claude",
      plan: "Pro",
      session: { usedPct: 30 },
      weekly: { usedPct: 10 },
      fetchedAt: 42,
    });
    expect(result?.error).toBeUndefined();
  });

  it("flags unparseable 200 bodies as unavailable", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shrug: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result?.error).toBe("limits unavailable");
  });

  it("flags network errors as unavailable", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result?.error).toBe("limits unavailable");
  });

  it("refreshFetchable() reflects token availability", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const provider = new ClaudeLimitsProvider({
      authManager: auth,
      fetchImpl: vi.fn(),
    });
    expect(await provider.refreshFetchable()).toBe(true);
    expect(provider.canFetch()).toBe(true);
  });
});
