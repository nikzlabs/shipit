import { describe, it, expect } from "vitest";
import { seedStatusCardSetting } from "./seed-inner-status-card.js";

interface Call { method: string; url: string; body?: unknown }

/**
 * `/api/bootstrap` answers the health poll AND the settings read, so one handler
 * serves both; `sessionStatusCard` is what each case varies.
 */
function fakeFetch(
  calls: Call[],
  opts: { on?: boolean; putStatus?: number } = {},
): typeof globalThis.fetch {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.endsWith("/api/bootstrap")) {
      return new Response(
        JSON.stringify({ settings: { sessionStatusCard: opts.on ?? false } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: opts.putStatus ?? 200 });
  }) as unknown as typeof globalThis.fetch;
}

const puts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "PUT");

describe("seedStatusCardSetting", () => {
  it("turns the setting on when it is off", async () => {
    const calls: Call[] = [];
    const result = await seedStatusCardSetting({ fetchImpl: fakeFetch(calls), env: {} });
    expect(result).toEqual({ outcome: "enabled" });
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body).toEqual({ sessionStatusCard: true });
  });

  // A PUT that changes nothing still marks every stored card stale (req 14),
  // which is the one thing this step must not do to the card it is seeding for.
  it("writes nothing when it is already on", async () => {
    const calls: Call[] = [];
    const result = await seedStatusCardSetting({ fetchImpl: fakeFetch(calls, { on: true }), env: {} });
    expect(result).toEqual({ outcome: "already-on" });
    expect(puts(calls)).toHaveLength(0);
  });

  it.each([
    ["DOGFOOD_SEED", "0"],
    ["DOGFOOD_SEED_STATUS_CARD", "0"],
  ])("is switched off by %s=%s", async (name, value) => {
    const calls: Call[] = [];
    const result = await seedStatusCardSetting({
      fetchImpl: fakeFetch(calls),
      env: { [name]: value },
    });
    expect(result).toEqual({ outcome: "skipped", reason: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("reports a refused save rather than claiming the setting is on", async () => {
    const calls: Call[] = [];
    const result = await seedStatusCardSetting({
      fetchImpl: fakeFetch(calls, { putStatus: 500 }),
      env: {},
    });
    expect(result.outcome).toBe("skipped");
  });

  it("gives up when the orchestrator never comes up", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;
    const result = await seedStatusCardSetting(
      { fetchImpl, env: {} },
      { timeoutMs: 5, pollIntervalMs: 1 },
    );
    expect(result).toEqual({ outcome: "skipped", reason: "orchestrator-down" });
  });
});
