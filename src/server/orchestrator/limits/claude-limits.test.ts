import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { ClaudeLimitsProvider, parseClaudeUsage } from "./claude-limits.js";
import { LIMITS_SKIP_TICK } from "./types.js";
import type { AuthManager } from "../auth.js";
import type { SubscriptionLimits } from "../../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_20X_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__/claude-usage-max-20x.json"), "utf-8"),
) as Record<string, unknown>;

function makeAuthStub(
  result: Awaited<ReturnType<AuthManager["getAccessToken"]>>,
): Pick<AuthManager, "getAccessToken"> {
  return { getAccessToken: vi.fn().mockResolvedValue(result) };
}

/** Fetch and assert the provider didn't skip, narrowing out the sentinel. */
async function fetchSnapshot(provider: ClaudeLimitsProvider): Promise<SubscriptionLimits | null> {
  const r = await provider.fetch();
  expect(r).not.toBe(LIMITS_SKIP_TICK);
  return r as SubscriptionLimits | null;
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

  // Real Anthropic /api/oauth/usage capture (Phase 0). Locks in the
  // exact shape verified against a Max-20x account on 2026-05-19. If
  // upstream changes this shape, the parser regression shows up here
  // first.
  describe("real /api/oauth/usage capture (Max 20x)", () => {
    it("parses session + weekly windows from the captured body", () => {
      const result = parseClaudeUsage(MAX_20X_FIXTURE, 0);
      expect(result).not.toBeNull();
      expect(result?.session?.usedPct).toBe(54);
      expect(result?.session?.resetAt).toBe("2026-05-19T16:19:59.805Z");
      expect(result?.weekly?.usedPct).toBe(16);
      expect(result?.weekly?.resetAt).toBe("2026-05-24T17:00:00.805Z");
    });

    it("returns null for weeklyOpus when the response carries null (Max 20x has no Opus-only quota right now)", () => {
      const result = parseClaudeUsage(MAX_20X_FIXTURE, 0);
      expect(result?.weeklyOpus).toBeNull();
    });

    it("does not include a plan field (Anthropic /usage omits it — plan comes from the credentials file)", () => {
      const result = parseClaudeUsage(MAX_20X_FIXTURE, 0);
      expect(result?.plan).toBeNull();
    });

    it("ignores the internal-codename keys without crashing", () => {
      // tangelo, iguana_necktie, omelette_promotional, seven_day_cowork,
      // seven_day_omelette — the parser ignores them silently. Future
      // regression test if upstream ever uses one of those names for
      // something we want to surface.
      const result = parseClaudeUsage(MAX_20X_FIXTURE, 0);
      expect(result).not.toBeNull();
    });
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

  it("skips the call when the access token is already expired (idle CLI hasn't refreshed it)", async () => {
    // expiresAt is in the past relative to `now` → the on-disk token
    // is stale; hitting /usage would 401. We skip instead.
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: 500, plan: "Pro" });
    const fetchImpl = vi.fn();
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl, now: () => 100_000 });
    const result = await provider.fetch();
    expect(result).toBe(LIMITS_SKIP_TICK);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still fetches when the token has a comfortable future expiry", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: 10_000_000, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl, now: () => 1_000 });
    await provider.fetch();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an auth-expired snapshot on 401", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl, now: () => 1_000 });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("auth expired");
    expect(result?.fetchedAt).toBe(1_000);
  });

  it("returns an unavailable snapshot on 5xx", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("oops", { status: 503 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("limits unavailable");
  });

  it("returns rate-limited snapshot on 429", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 429 }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("rate limited");
  });

  it("returns a parsed snapshot on a well-formed 200", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
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
    const result = await fetchSnapshot(provider);
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
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shrug: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("limits unavailable");
  });

  it("flags network errors as unavailable", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.error).toBe("limits unavailable");
  });

  it("refreshFetchable() reflects token availability", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const provider = new ClaudeLimitsProvider({
      authManager: auth,
      fetchImpl: vi.fn(),
    });
    expect(await provider.refreshFetchable()).toBe(true);
    expect(provider.canFetch()).toBe(true);
  });

  it("threads the auth-derived plan label into the snapshot (Phase 0: /usage omits plan)", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Max 20x" });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(MAX_20X_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.plan).toBe("Max 20x");
    expect(result?.session?.usedPct).toBe(54);
    expect(result?.weekly?.usedPct).toBe(16);
    expect(result?.error).toBeUndefined();
  });

  it("error snapshots also carry the plan label so the tooltip stays informative", async () => {
    const auth = makeAuthStub({ token: "tok", source: "file", expiresAt: null, plan: "Pro" });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const provider = new ClaudeLimitsProvider({ authManager: auth, fetchImpl });
    const result = await fetchSnapshot(provider);
    expect(result?.plan).toBe("Pro");
    expect(result?.error).toBe("limits unavailable");
  });
});
