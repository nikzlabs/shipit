import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MobileStatusPanel } from "./MobileStatusPanel.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { resetAutoRefreshThrottle } from "./SubscriptionLimitsBadge.js";
import type { SubscriptionLimits } from "../../server/shared/types.js";

/** docs/150 — wrap snapshots into the provider → route → limits wire shape. */
function routed(...snaps: SubscriptionLimits[]): Record<string, SubscriptionLimits> {
  return Object.fromEntries(snaps.map((snap) => [snap.routeId, snap]));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
});

const FUTURE_SESSION_RESET = new Date(Date.now() + 60 * 60_000).toISOString();
const FUTURE_WEEKLY_RESET = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();

function makeSnap(overrides: Partial<SubscriptionLimits> = {}): SubscriptionLimits {
  const serviceId = overrides.serviceId ?? "anthropic";
  return {
    serviceId,
    billingMode: "sub",
    routeId: `acct-${serviceId}`,
    plan: "Pro",
    session: { usedPct: 30, resetAt: FUTURE_SESSION_RESET },
    weekly: { usedPct: 50, resetAt: FUTURE_WEEKLY_RESET },
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("MobileStatusPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAutoRefreshThrottle();
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  function refreshCalls(): unknown[][] {
    return fetchMock.mock.calls.filter((call) => call[0] === "/api/limits/refresh");
  }

  it("renders only the sections it has data for", () => {
    render(
      <MobileStatusPanel
        subscriptionLimits={{}}
        dockerMemory={null}
        processStartedAt={Date.parse("2026-05-19T12:00:00Z")}
      />,
    );
    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.queryByText("Subscription")).toBeNull();
    expect(screen.queryByText("Docker memory")).toBeNull();
  });

  it("refreshes subscription usage as soon as the dropdown opens", async () => {
    // The panel is the popover's content, so mounting it *is* the open gesture
    // — the user shouldn't need a second tap on the refresh glyph.
    render(
      <MobileStatusPanel
        subscriptionLimits={{ "anthropic:sub": routed(makeSnap()) }}
        dockerMemory={null}
        processStartedAt={null}
      />,
    );
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    expect(JSON.parse((refreshCalls()[0][1] as RequestInit).body as string)).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      routeId: "acct-anthropic",
    });
  });

  it("makes no refresh call when there is no subscription snapshot to update", async () => {
    render(
      <MobileStatusPanel
        subscriptionLimits={{}}
        dockerMemory={null}
        processStartedAt={Date.now()}
      />,
    );
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("shows and refreshes a connected account that has no usage snapshot yet", async () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-quiet", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Quiet account", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);

    render(
      <MobileStatusPanel
        subscriptionLimits={{}}
        dockerMemory={null}
        processStartedAt={null}
      />,
    );

    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText("Quiet account")).toBeInTheDocument();
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
  });
});

/**
 * docs/274 req 16 — the heading has to follow the pill, not the account list.
 *
 * A subscription ShipIt can read no quota for renders no pill (xAI publishes no
 * usage API), so a panel that asked "any connected account?" put a
 * "Subscription" heading above an empty box — the same empty-affordance failure
 * as the blank pill, one level up.
 */
describe("MobileStatusPanel with a no-quota subscription", () => {
  const now = Date.now();

  it("drops the Subscription section when the only account reports no quota", () => {
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-go", serviceId: "opencode", billingMode: "sub", via: "account", label: "nik@go", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    render(
      <MobileStatusPanel
        subscriptionLimits={{}}
        dockerMemory={null}
        processStartedAt={Date.parse("2026-05-19T12:00:00Z")}
      />,
    );
    expect(screen.queryByText("Subscription")).toBeNull();
    // The panel is not empty — it still has the section it does have data for.
    expect(screen.getByText("Uptime")).toBeInTheDocument();
  });

  it("keeps the section when an account beside it does report one", () => {
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-go", serviceId: "opencode", billingMode: "sub", via: "account", label: "nik@go", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    render(
      <MobileStatusPanel
        subscriptionLimits={{ "anthropic:sub": routed(makeSnap({ routeId: "acct-work" })) }}
        dockerMemory={null}
        processStartedAt={null}
      />,
    );
    expect(screen.getByText("Subscription")).toBeInTheDocument();
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.queryByText("nik@go")).toBeNull();
  });
});
