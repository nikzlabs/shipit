import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { statusGroupBreakpoint } from "./AppLayout.js";
import { useSubscriptionPillCount } from "./components/SubscriptionLimitsBadge.js";
import { useSettingsStore } from "./stores/settings-store.js";
import type { SubscriptionLimitsMap } from "../server/shared/types.js";

afterEach(() => {
  cleanup();
  useSettingsStore.getState().setProviderAccounts([]);
});

describe("statusGroupBreakpoint", () => {
  it("keeps the one-account header exactly as it was", () => {
    expect(statusGroupBreakpoint(1)).toEqual({
      statusInline: "hidden sm:contents",
      statusCollapsed: "sm:hidden",
    });
    expect(statusGroupBreakpoint(0)).toEqual(statusGroupBreakpoint(1));
  });

  it("raises the inline threshold as accounts are added", () => {
    expect(statusGroupBreakpoint(2)).toEqual({
      statusInline: "hidden md:contents",
      statusCollapsed: "md:hidden",
    });
    expect(statusGroupBreakpoint(3)).toEqual({
      statusInline: "hidden lg:contents",
      statusCollapsed: "lg:hidden",
    });
  });

  it("does not escalate past lg — beyond three pills, truncation carries it", () => {
    expect(statusGroupBreakpoint(9)).toEqual(statusGroupBreakpoint(3));
  });

  it("pairs each inline breakpoint with its own collapse breakpoint", () => {
    for (const count of [0, 1, 2, 3, 4]) {
      const { statusInline, statusCollapsed } = statusGroupBreakpoint(count);
      expect(statusInline).toBe(`hidden ${statusCollapsed.replace(":hidden", "")}:contents`);
    }
  });
});

describe("useSubscriptionPillCount", () => {
  const now = Date.now();

  it("counts connected accounts, including ones that have never reported usage", () => {
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-personal", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal", isPrimary: false, status: "ready", createdAt: now, updatedAt: now },
    ]);

    const { result } = renderHook(() => useSubscriptionPillCount({}));
    expect(result.current).toBe(2);
  });

  it("counts a reserved route that only the snapshot map knows about", () => {
    const limits: SubscriptionLimitsMap = {
      "anthropic:sub": {
        "claude-env-oauth": {
          serviceId: "anthropic",
          billingMode: "sub",
          routeId: "claude-env-oauth",
          plan: null,
          session: null,
          weekly: null,
          fetchedAt: now,
        },
      },
    };

    const { result } = renderHook(() => useSubscriptionPillCount(limits));
    expect(result.current).toBe(1);
  });

  it("is zero with nothing connected, which leaves the header untouched", () => {
    const { result } = renderHook(() => useSubscriptionPillCount({}));
    expect(result.current).toBe(0);
  });
});
