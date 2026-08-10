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

/**
 * docs/150 — the header's status group has to make room for one named pill per
 * connected subscription (req 10). These cover the rule that decides whether it
 * renders inline or collapses into the status dropdown; the widths themselves
 * were checked in the running app at 640 / 768 / 900 / 1024 / 1280.
 */
describe("statusGroupBreakpoint", () => {
  it("keeps the one-account header exactly as it was", () => {
    // The single-pill layout is the one users have today, and it fits from
    // `sm` — changing it would be a regression dressed up as a fix.
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
    // There is no wider breakpoint to escalate to, and a fourth account must
    // not push the group into the dropdown on every desktop.
    expect(statusGroupBreakpoint(9)).toEqual(statusGroupBreakpoint(3));
  });

  // The inline and collapsed classes are complements: exactly one of the two
  // surfaces renders at any width. A mismatch would either duplicate the pills
  // or hide them entirely.
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

  // A reserved env/API-key route has no account row, so it exists only as a
  // snapshot — but it still occupies a pill's worth of header.
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
