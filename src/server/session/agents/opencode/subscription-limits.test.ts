import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeSubscriptionLimits, parseOpenCodeSubscriptionLimits } from "./subscription-limits.js";
import { openCodeAccessToken, OPENCODE_ACCOUNT_MARKER, writeOpenCodeAccount } from "../../../shared/opencode-account.js";

import capturedWeekly from "./__fixtures__/chatgpt-usage-weekly.json";

it("parses a sanitized live ChatGPT usage response captured on 2026-09-20", () => {
  expect(parseOpenCodeSubscriptionLimits(capturedWeekly)).toMatchObject({
    type: "agent_rate_limits", session: null, weekly: { usedPct: 37, resetAt: "2033-05-18T03:33:20.000Z" },
  });
});

const fiveHour = { used_percent: 42, limit_window_seconds: 18_000, reset_at: 2_000_000_000 };
const weekly = { used_percent: 73, limit_window_seconds: 604_800, reset_at: 2_000_500_000 };
const payload = { rate_limit: { primary_window: fiveHour, secondary_window: weekly } };

it("maps the account windows by duration, including a lone weekly primary", () => {
  expect(parseOpenCodeSubscriptionLimits(payload)).toEqual({
    type: "agent_rate_limits",
    session: { usedPct: 42, resetAt: new Date(fiveHour.reset_at * 1000).toISOString(), startedAt: new Date((fiveHour.reset_at - 18000) * 1000).toISOString() },
    weekly: { usedPct: 73, resetAt: new Date(weekly.reset_at * 1000).toISOString(), startedAt: new Date((weekly.reset_at - 604800) * 1000).toISOString() },
  });
  expect(parseOpenCodeSubscriptionLimits({ rate_limit: { primary_window: weekly } })).toMatchObject({ session: null, weekly: { usedPct: 73 } });
});

it.each([null, {}, { rate_limit: null }, { rate_limit: { primary_window: { ...fiveHour, used_percent: "42" } } },
  { rate_limit: { primary_window: { ...fiveHour, reset_at: 1e99 } } },
  { rate_limit: { primary_window: { ...fiveHour, limit_window_seconds: 60 } } },
])("rejects missing or malformed windows without inventing zero usage: %j", (raw) => {
  expect(parseOpenCodeSubscriptionLimits(raw)).toBeNull();
});

it("normalizes a millisecond reset timestamp", () => {
  expect(parseOpenCodeSubscriptionLimits({ rate_limit: { primary_window: { ...fiveHour, reset_at: fiveHour.reset_at * 1000 } } }))
    .toEqual(parseOpenCodeSubscriptionLimits({ rate_limit: { primary_window: fiveHour } }));
});

describe("OpenCode account limit reader", () => {
  let dataHome: string;
  let monitor: OpenCodeSubscriptionLimits;
  const onLimits = vi.fn();
  const onFailure = vi.fn();
  const fetchFn = vi.fn<typeof fetch>();

  function provision(accountId = "external-a", nonce = "first") {
    const access_token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, nonce, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.test`;
    writeOpenCodeAccount(dataHome, openCodeAccessToken({ tokens: { access_token } }));
    fs.writeFileSync(path.join(dataHome, OPENCODE_ACCOUNT_MARKER), JSON.stringify({ accountId: "route-a" }));
    return access_token;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-limits-"));
    provision();
    fetchFn.mockImplementation(async () => Response.json(payload));
    monitor = new OpenCodeSubscriptionLimits({ dataHome, routeId: "route-a", onLimits, onFailure, fetchFn });
  });
  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it("reads at start and finish with current credentials, without polling", async () => {
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLimits).toHaveBeenCalledOnce();
    const renewed = provision("external-a", "renewed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledOnce();
    await monitor.finish();
    expect(fetchFn).toHaveBeenLastCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${renewed}`, "ChatGPT-Account-Id": "external-a" }),
      redirect: "error",
    }));
    expect(onLimits).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not request an account whose route marker no longer matches", async () => {
    fs.writeFileSync(path.join(dataHome, OPENCODE_ACCOUNT_MARKER), JSON.stringify({ accountId: "route-b" }));
    await monitor.finish();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onLimits).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it.each(["stop", "rebind", "revoke"])("drops an in-flight reading after %s", async (action) => {
    let resolve!: (value: Response) => void;
    fetchFn.mockImplementation(() => new Promise((r) => { resolve = r; }));
    monitor.start();
    if (action === "stop") monitor.stop();
    else if (action === "rebind") provision("external-b");
    else fs.rmSync(path.join(dataHome, OPENCODE_ACCOUNT_MARKER));
    resolve(Response.json(payload));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLimits).not.toHaveBeenCalled();
  });

  it("bounds slow reads and completes finish on timeout", async () => {
    fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFailure).toHaveBeenCalledOnce();
    const finished = monitor.finish();
    await vi.advanceTimersByTimeAsync(2_000);
    await finished;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onLimits).not.toHaveBeenCalled();
  });

  it("cancels a final read on disposal and does not emit a late update", async () => {
    fetchFn.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const finished = monitor.finish();
    monitor.stop();
    await finished;
    expect(onLimits).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a rate-limited start request at settlement", async () => {
    fetchFn.mockImplementation(async () => new Response("", { status: 429 }));
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    await monitor.finish();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("keeps listener failures separate from usage read failures", async () => {
    onLimits.mockImplementationOnce(() => { throw new Error("listener failed"); });
    await expect(monitor.finish()).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledWith("OpenAI subscription limit update could not be delivered.");
  });

  it("rejects a response for another account", async () => {
    fetchFn.mockImplementation(async () => Response.json({ ...payload, account_id: "external-b" }));
    await monitor.finish();
    expect(onLimits).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("discards a start reading that completes after the final reading", async () => {
    let resolveStart!: (value: Response) => void;
    fetchFn.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    monitor.start();
    await monitor.finish();
    expect(onLimits).toHaveBeenCalledOnce();
    resolveStart(Response.json({ rate_limit: { primary_window: { ...fiveHour, used_percent: 1 } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLimits).toHaveBeenCalledOnce();
  });

  it("does not expose upstream error bodies or credential-bearing exceptions", async () => {
    fetchFn.mockRejectedValue(new Error("secret-access-token"));
    await monitor.finish();
    expect(onFailure).toHaveBeenCalledWith("OpenAI subscription limits could not be updated; keeping the last reading.");
    expect(onLimits).not.toHaveBeenCalled();
  });
});
