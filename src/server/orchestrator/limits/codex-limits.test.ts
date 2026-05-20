import { describe, it, expect, vi } from "vitest";
import { CodexLimitsProvider, parseCodexUsage } from "./codex-limits.js";
import { LIMITS_SKIP_TICK } from "./types.js";
import type { CodexAuthManager } from "../codex-auth.js";
import type { SubscriptionLimits } from "../../shared/types.js";

function makeAuthStub(
  result: Awaited<ReturnType<CodexAuthManager["getAccessToken"]>>,
): Pick<CodexAuthManager, "getAccessToken"> {
  return { getAccessToken: vi.fn().mockResolvedValue(result) };
}

/** Fetch and assert the provider didn't skip, narrowing out the sentinel. */
async function fetchSnapshot(provider: CodexLimitsProvider): Promise<SubscriptionLimits | null> {
  const r = await provider.fetch();
  expect(r).not.toBe(LIMITS_SKIP_TICK);
  return r as SubscriptionLimits | null;
}

describe("parseCodexUsage", () => {
  it("parses session + weekly windows", () => {
    const result = parseCodexUsage(
      {
        plan: "Plus",
        five_hour: { utilization: 0.45, resets_at: "2026-05-20T18:00:00Z" },
        weekly: { utilization: 0.18, resets_at: "2026-05-27T00:00:00Z" },
      },
      0,
    );
    expect(result?.plan).toBe("Plus");
    expect(result?.session?.usedPct).toBeCloseTo(45, 5);
    expect(result?.weekly?.usedPct).toBeCloseTo(18, 5);
  });

  it("returns null when no recognizable window is present", () => {
    expect(parseCodexUsage({ unknown: "shape" }, 0)).toBeNull();
    expect(parseCodexUsage(null, 0)).toBeNull();
  });
});

describe("CodexLimitsProvider", () => {
  it("returns null when no token is available", async () => {
    const auth = makeAuthStub({ token: null, reason: "not-authenticated" });
    const fetchImpl = vi.fn();
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, fetchImpl });
    const result = await provider.fetch();
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips the call when the access token is already expired (idle CLI hasn't refreshed it)", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: 500 });
    const fetchImpl = vi.fn();
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, fetchImpl, now: () => 100_000 });
    const result = await provider.fetch();
    expect(result).toBe(LIMITS_SKIP_TICK);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still fetches when expiresAt is null (unknown TTL)", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, fetchImpl, now: () => 1_000 });
    await provider.fetch();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an auth-expired snapshot on 401", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: 10_000_000 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, fetchImpl, now: () => 1_000 });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("auth expired");
  });

  it("returns a parsed snapshot on a well-formed 200", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: 10_000_000 });
    const body = {
      plan: "Plus",
      five_hour: { utilization: 0.3, resets_at: "2026-05-20T18:00:00Z" },
      weekly: { utilization: 0.1, resets_at: "2026-05-27T00:00:00Z" },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new CodexLimitsProvider({ codexAuthManager: auth, fetchImpl, now: () => 42 });
    const result = await fetchSnapshot(provider);
    expect(result).toMatchObject({
      agentId: "codex",
      plan: "Plus",
      session: { usedPct: 30 },
      weekly: { usedPct: 10 },
      fetchedAt: 42,
    });
  });
});
