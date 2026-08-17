import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import {
  SubscriptionLimitsBadge,
  SubscriptionLimitPill,
  tierColor,
  formatPct,
  formatResetCountdown,
  formatAge,
  meterDisplay,
  timeElapsedPct,
  resetAutoRefreshThrottle,
  AUTO_REFRESH_MIN_INTERVAL_MS,
} from "./SubscriptionLimitsBadge.js";
import type { SubscriptionLimits, SubscriptionLimitsMap } from "../../server/shared/types.js";
import { useSettingsStore } from "../stores/settings-store.js";

/** docs/150 — wrap snapshots into the provider → route → limits wire shape. */
function routed(...snaps: SubscriptionLimits[]): Record<string, SubscriptionLimits> {
  return Object.fromEntries(snaps.map((snap) => [snap.routeId, snap]));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.getState().setProviderAccounts([]);
});

// Reset timestamps live in the future relative to the test clock so the
// meter doesn't collapse to 0 via the elapsed-reset rule (see
// `effectivePct`). Tests that want the elapsed behavior pass a past
// timestamp explicitly.
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

describe("formatPct", () => {
  it("rounds and suffixes with %", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(33.4)).toBe("33%");
    expect(formatPct(99.6)).toBe("100%");
  });
});

describe("formatResetCountdown", () => {
  it("formats reset timestamps as compact durations", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(formatResetCountdown("2026-05-19T12:20:00Z", now)).toBe("20m");
    expect(formatResetCountdown("2026-05-19T14:01:00Z", now)).toBe("3h");
    expect(formatResetCountdown("2026-05-21T15:00:00Z", now)).toBe("2d 3h");
  });

  it("handles elapsed and unparsable reset timestamps", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(formatResetCountdown("2026-05-19T11:59:00Z", now)).toBe("now");
    expect(formatResetCountdown("not-a-date", now)).toBe("not-a-date");
  });
});

describe("formatAge", () => {
  it("formats snapshot age compactly", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(formatAge(now - 30_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAge(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatAge(now - 2 * 24 * 60 * 60_000, now)).toBe("2d ago");
  });
});

describe("timeElapsedPct", () => {
  it("uses a stable explicit anchor when a rolling reset moves forward", () => {
    const now = Date.parse("2026-05-19T14:00:00Z");
    expect(
      timeElapsedPct("2026-05-19T19:00:00Z", 5 * 60 * 60_000, now, "2026-05-19T12:00:00Z"),
    ).toBe(40);
  });
});

describe("meterDisplay", () => {
  const now = Date.parse("2026-05-19T12:00:00Z");
  const future = "2026-05-19T17:00:00Z";
  const past = "2026-05-19T11:59:00Z";

  it("classifies a fresh known window", () => {
    expect(meterDisplay({ usedPct: 42, resetAt: future }, now, now)).toEqual({
      kind: "known",
      pct: 42,
      stale: false,
    });
  });

  it("marks a known window stale once it ages past the threshold", () => {
    const old = now - 20 * 60_000;
    expect(meterDisplay({ usedPct: 42, resetAt: future }, old, now)).toEqual({
      kind: "known",
      pct: 42,
      stale: true,
    });
  });

  it("classifies an elapsed window as reset (regardless of usedPct)", () => {
    expect(meterDisplay({ usedPct: 100, resetAt: past }, now, now)).toEqual({ kind: "reset" });
    expect(meterDisplay({ usedPct: null, resetAt: past }, now, now)).toEqual({ kind: "reset" });
  });

  it("classifies a null-utilization open window as unknown", () => {
    expect(meterDisplay({ usedPct: null, resetAt: future }, now, now)).toEqual({ kind: "unknown" });
  });
});

describe("timeElapsedPct", () => {
  const windowMs = 7 * 24 * 60 * 60_000; // 7d
  const now = Date.parse("2026-05-19T12:00:00Z");

  it("returns the fraction of the window already elapsed", () => {
    // resets in 7d → 0% elapsed; resets now → 100% elapsed; halfway → 50%.
    const justStarted = new Date(now + windowMs).toISOString();
    const halfway = new Date(now + windowMs / 2).toISOString();
    expect(timeElapsedPct(justStarted, windowMs, now)).toBeCloseTo(0, 5);
    expect(timeElapsedPct(halfway, windowMs, now)).toBeCloseTo(50, 5);
  });

  it("clamps to 0–100 for resets outside the nominal window", () => {
    const farFuture = new Date(now + windowMs * 2).toISOString(); // before start
    const past = new Date(now - 60_000).toISOString(); // after reset
    expect(timeElapsedPct(farFuture, windowMs, now)).toBe(0);
    expect(timeElapsedPct(past, windowMs, now)).toBe(100);
  });

  it("returns null for an unparseable reset timestamp", () => {
    expect(timeElapsedPct("not-a-date", windowMs, now)).toBeNull();
  });
});

describe("tierColor", () => {
  it("stays neutral (text-secondary) under 60%", () => {
    expect(tierColor(0)).toContain("--color-text-secondary");
    expect(tierColor(59.9)).toContain("--color-text-secondary");
  });

  it("uses the mid context token in the 60-74% band", () => {
    expect(tierColor(60)).toContain("--color-context-mid");
    expect(tierColor(74.9)).toContain("--color-context-mid");
  });

  it("uses the high context token in the 75-89% band", () => {
    expect(tierColor(75)).toContain("--color-context-high");
    expect(tierColor(89.9)).toContain("--color-context-high");
  });

  it("uses the full context token at 90% and above", () => {
    expect(tierColor(90)).toContain("--color-context-full");
    expect(tierColor(100)).toContain("--color-context-full");
  });
});

describe("SubscriptionLimitsBadge group", () => {
  it("renders nothing when the map and connected account list are empty", () => {
    const { container } = render(<SubscriptionLimitsBadge limits={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps every connected provider visible before either has reported usage", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-claude", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Claude work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-codex", serviceId: "openai", billingMode: "sub", via: "account", label: "Codex work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);

    render(<SubscriptionLimitsBadge limits={{}} />);

    expect(screen.getByText("Claude work")).toBeInTheDocument();
    expect(screen.getByText("Codex work")).toBeInTheDocument();
    expect(screen.getAllByText(/5h · —/)).toHaveLength(2);
    expect(screen.getAllByText(/7d · —/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Refresh subscription usage" })).toBeInTheDocument();
  });

  // docs/252 req 10 — a group is a `(service, billing mode)`, so an unnamed
  // route's pill carries the SERVICE's name. It used to say "Claude", which
  // named the harness rather than the thing that owns the quota.
  it("renders one row for one service", () => {
    const limits: SubscriptionLimitsMap = { "anthropic:sub": routed(makeSnap()) };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText(/5h 30%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 50%/)).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).toBeNull();
  });

  it("renders one labelled pill per connected account (docs/150-multiple-provider-subscriptions req 10)", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-personal", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal", isPrimary: false, status: "ready", createdAt: now, updatedAt: now },
    ]);
    const limits: SubscriptionLimitsMap = {
      "anthropic:sub": {
        // Reversed vs the account order to prove the pills follow the user's
        // account order, not map insertion order.
        "acct-personal": makeSnap({ routeId: "acct-personal", session: { usedPct: 12, resetAt: FUTURE_SESSION_RESET } }),
        "acct-work": makeSnap({ routeId: "acct-work", session: { usedPct: 88, resetAt: FUTURE_SESSION_RESET } }),
      },
    };
    const { container } = render(<SubscriptionLimitsBadge limits={limits} />);

    const rows = container.querySelectorAll(":scope > span");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toMatch(/^Work/);
    expect(rows[0].textContent).toMatch(/5h 88%/);
    expect(rows[1].textContent).toMatch(/^Personal/);
    expect(rows[1].textContent).toMatch(/5h 12%/);
  });

  // docs/150 — the header row is finite and each account adds a ~250px pill.
  // jsdom has no layout engine, so the assertion is on the two declarations
  // that decide who gives ground: the pill may shrink below its content, and
  // the label is the part that yields. Without them, three accounts pushed the
  // header's trailing controls off-screen and slid the first pill under the
  // logo (observed at 900px in the running app).
  it("lets a pill shrink by truncating its label, not by overflowing the row", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "nicolas.zherebtsov@gmail.com", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    const limits: SubscriptionLimitsMap = { "anthropic:sub": routed(makeSnap({ routeId: "acct-work" })) };
    const { container } = render(<SubscriptionLimitsBadge limits={limits} />);

    const pill = container.querySelector(":scope > span");
    expect(pill?.className).toContain("min-w-0");
    const label = screen.getByText("nicolas.zherebtsov@gmail.com");
    expect(label.className).toContain("truncate");
    // The full value stays reachable — truncation hides characters, not facts.
    expect(label).toHaveAttribute("title", expect.stringContaining("nicolas.zherebtsov@gmail.com"));
  });

  // req 10 asks for the account name outright, so it is shown even when there
  // is only one pill.
  it("labels a single account's pill with the account name", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
    ]);
    const limits: SubscriptionLimitsMap = { "anthropic:sub": routed(makeSnap({ routeId: "acct-work" })) };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText("Work")).toBeInTheDocument();
  });

  it("renders the quiet account alongside an account with a snapshot", () => {
    const now = Date.now();
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-work", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Work", isPrimary: true, status: "ready", createdAt: now, updatedAt: now },
      { id: "acct-personal", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Personal", isPrimary: false, status: "ready", createdAt: now, updatedAt: now },
    ]);
    const limits: SubscriptionLimitsMap = { "anthropic:sub": routed(makeSnap({ routeId: "acct-work" })) };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getAllByText(/5h · —/)).toHaveLength(1);
  });

  // Reserved env / API-key routes are not accounts, so they keep the service
  // label rather than inventing a name for something the user never named.
  it("keeps the service label for a reserved route", () => {
    useSettingsStore.getState().setProviderAccounts([]);
    const limits: SubscriptionLimitsMap = { "anthropic:sub": routed(makeSnap({ routeId: "claude-env-oauth" })) };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
  });

  it("renders both rows in stable order: Anthropic then OpenAI", () => {
    const limits: SubscriptionLimitsMap = {
      // Map insertion order is reversed to confirm the component
      // doesn't naively use it.
      "openai:sub": routed(makeSnap({ serviceId: "openai",
    billingMode: "sub", plan: "Plus", session: { usedPct: 10, resetAt: "x" }, weekly: { usedPct: 5, resetAt: "y" } })),
      "anthropic:sub": routed(makeSnap({ serviceId: "anthropic", billingMode: "sub" })),
    };
    const { container } = render(<SubscriptionLimitsBadge limits={limits} />);
    const rows = container.querySelectorAll(":scope > span");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toMatch(/^Anthropic/);
    expect(rows[1].textContent).toMatch(/^OpenAI/);
  });
});

describe("SubscriptionLimitPill", () => {
  it("renders session and weekly meters when both present", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 96, resetAt: FUTURE_SESSION_RESET },
          weekly: { usedPct: 22, resetAt: FUTURE_WEEKLY_RESET },
        })}
      />,
    );
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(/5h 96%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 22%/)).toBeInTheDocument();
  });

  it("shows reset countdown text inline for session limits above 90%", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 96, resetAt: FUTURE_SESSION_RESET },
          weekly: { usedPct: 22, resetAt: FUTURE_WEEKLY_RESET },
        })}
      />,
    );
    expect(screen.getByText(/5h 96%/).closest("[data-meter-pct]")).toHaveTextContent(/resets in/);
    expect(screen.getByText(/7d 22%/)).not.toHaveTextContent(/resets in/);
  });

  it("shows reset countdown text inline for weekly limits above 90%", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 20, resetAt: FUTURE_SESSION_RESET },
          weekly: { usedPct: 94, resetAt: FUTURE_WEEKLY_RESET },
        })}
      />,
    );
    expect(screen.getByText(/5h 20%/)).not.toHaveTextContent(/resets in/);
    expect(screen.getByText(/7d 94%/).closest("[data-meter-pct]")).toHaveTextContent(/resets in/);
  });

  it("limits the progress track to the usage value instead of the reset countdown", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 20, resetAt: FUTURE_SESSION_RESET },
          weekly: { usedPct: 94, resetAt: FUTURE_WEEKLY_RESET },
        })}
      />,
    );

    const weeklyValue = screen.getByText(/7d 94%/);
    const weeklyMeter = weeklyValue.closest("[data-meter-pct]");
    const track = weeklyValue.querySelector("[data-meter-track]");
    expect(track?.parentElement).toHaveAttribute("data-meter-value");
    expect(track?.parentElement).toHaveTextContent(/^7d 94%$/);
    expect(weeklyMeter).toHaveTextContent(/resets in/);
  });

  it("does not show reset countdown text at exactly 90%", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 90, resetAt: FUTURE_SESSION_RESET },
          weekly: { usedPct: 90, resetAt: FUTURE_WEEKLY_RESET },
        })}
      />,
    );
    expect(screen.getByText(/5h 90%/)).not.toHaveTextContent(/resets in/);
    expect(screen.getByText(/7d 90%/)).not.toHaveTextContent(/resets in/);
  });

  it("keeps both window blocks visible when session usage has not been reported", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: { usedPct: 40, resetAt: "x" } })}
      />,
    );
    expect(screen.getByText(/5h · —/)).toHaveAttribute("title", expect.stringContaining("usage not reported yet"));
    expect(screen.getByText(/7d 40%/)).toBeInTheDocument();
  });

  it("renders each meter's fill width proportional to its percentage", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 96, resetAt: "x" },
          weekly: { usedPct: 22, resetAt: "y" },
        })}
      />,
    );
    const meters = container.querySelectorAll("[data-meter-pct]");
    expect(meters.length).toBe(2);
    expect(meters[0].getAttribute("data-meter-pct")).toBe("96");
    expect(meters[1].getAttribute("data-meter-pct")).toBe("22");
    const fills = container.querySelectorAll<HTMLElement>("[data-meter-fill]");
    expect(fills[0].style.width).toBe("96%");
    expect(fills[1].style.width).toBe("22%");
  });

  it("fills each meter independently from its own percentage", () => {
    // 5h at 96% → full (red) tier; 7d at 22% → neutral tier.
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 96, resetAt: "x" },
          weekly: { usedPct: 22, resetAt: "y" },
        })}
      />,
    );
    const fills = container.querySelectorAll<HTMLElement>("[data-meter-fill]");
    expect(fills[0].style.backgroundColor).toContain("--color-context-full");
    expect(fills[1].style.backgroundColor).toContain("--color-text-secondary");
  });

  it("tiers each meter's text color from its own percentage", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 96, resetAt: "x" },
          weekly: { usedPct: 22, resetAt: "y" },
        })}
      />,
    );
    const meters = container.querySelectorAll<HTMLElement>("[data-meter-pct]");
    expect(meters[0].style.color).toContain("--color-context-full");
    expect(meters[1].style.color).toContain("--color-text-secondary");
  });

  it("shows an explicit 'reset' state once the meter's resetAt has elapsed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 100, resetAt: past },
          weekly: { usedPct: 91, resetAt: future },
        })}
      />,
    );
    // 5h window has elapsed → muted "reset" label, not a fabricated 0%/100%.
    expect(screen.getByText(/5h · reset/)).toBeInTheDocument();
    expect(screen.queryByText(/5h 0%/)).toBeNull();
    expect(screen.queryByText(/5h 100%/)).toBeNull();
    // No gauge fill in the reset state — only the still-open weekly has one.
    const fills = container.querySelectorAll<HTMLElement>("[data-meter-fill]");
    expect(fills.length).toBe(1);
    // Weekly window is still open — unchanged.
    expect(screen.getByText(/7d 91%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 91%/).closest("[data-meter-pct]")).toHaveTextContent(/resets in/);
  });

  it("clamps fill width to the 0–100 range for out-of-range inputs", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 150, resetAt: "x" },
          weekly: { usedPct: -10, resetAt: "y" },
        })}
      />,
    );
    const fills = container.querySelectorAll<HTMLElement>("[data-meter-fill]");
    expect(fills[0].style.width).toBe("100%");
    expect(fills[1].style.width).toBe("0%");
  });

  it("renders explicit 5h and 7d unknown blocks when no windows are present", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: null })}
      />,
    );
    expect(screen.getByText(/5h · —/)).toBeInTheDocument();
    expect(screen.getByText(/7d · —/)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-meter-pct="unreported"]')).toHaveLength(2);
  });

  it("includes plan name in the tooltip when present", () => {
    render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ plan: "Max 20x" })} />,
    );
    expect(screen.getByText("Claude")).toHaveAttribute("title", expect.stringContaining("Max 20x"));
  });

  it("gives each quota block its own window-specific tooltip", () => {
    render(<SubscriptionLimitPill label="Codex" snapshot={makeSnap({ serviceId: "openai", billingMode: "sub" })} />);

    const session = screen.getByText(/5h 30%/).closest("[data-meter-pct]");
    const weekly = screen.getByText(/7d 50%/).closest("[data-meter-pct]");
    if (!session || !weekly) throw new Error("Expected both quota meter wrappers");
    expect(session).toHaveAttribute("title", expect.stringContaining("5h window: 30% used"));
    expect(session.getAttribute("title")).not.toContain("7d window");
    expect(weekly).toHaveAttribute("title", expect.stringContaining("7d window: 50% used"));
    expect(weekly.getAttribute("title")).not.toContain("5h window");
  });

  it("renders an explicit unknown state (no percentage, no countdown) when usedPct is null", () => {
    // Claude CLI 2.1.140 reports the window without `utilization` below its
    // warning thresholds (anthropics/claude-code#50518). The pill must read as
    // "unknown" rather than a bare reset countdown that looks like data
    // (docs/161).
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: null, resetAt: future },
          weekly: null,
        })}
      />,
    );
    // Explicit "—" marker, no percentage, and the reset countdown is NOT the
    // headline (it moves to the tooltip).
    expect(screen.getByText(/5h · —/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByText(/resets in/)).toBeNull();
    // No fill bar and no time marker in the unknown state.
    expect(container.querySelector("[data-meter-fill]")).toBeNull();
    expect(container.querySelector("[data-time-marker]")).toBeNull();
    // Tooltip explains the absence and points at the refresh button.
    expect(screen.getByText(/5h · —/).getAttribute("title")).toContain(
      "usage not reported",
    );
  });

  it("dims a stale known meter", () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: { usedPct: 42, resetAt: future },
          weekly: null,
          fetchedAt: Date.now() - 20 * 60_000,
        })}
      />,
    );
    const meter = container.querySelector('[data-meter-pct="42"]');
    expect(meter?.className).toContain("opacity-50");
  });

  it("renders a time marker positioned at the elapsed fraction of the window", () => {
    // Weekly (7d) window resetting in 3.5d → ~50% of the window elapsed, so
    // the marker sits at ~50% regardless of the 48% quota fill.
    const halfwayWeekly = new Date(Date.now() + 3.5 * 24 * 60 * 60_000).toISOString();
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: { usedPct: 48, resetAt: halfwayWeekly } })}
      />,
    );
    const marker = container.querySelector<HTMLElement>("[data-time-marker]");
    expect(marker).not.toBeNull();
    expect(parseFloat(marker!.style.left)).toBeCloseTo(50, 0);
  });

  it("omits the time marker when resetAt is unparseable", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: { usedPct: 48, resetAt: "x" } })}
      />,
    );
    // The quota fill still renders; the marker is skipped rather than drawn
    // at a bogus position.
    expect(container.querySelector("[data-meter-fill]")).not.toBeNull();
    expect(container.querySelector("[data-time-marker]")).toBeNull();
  });

  it("fades the time marker along with a stale meter", () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          session: null,
          weekly: { usedPct: 42, resetAt: future },
          fetchedAt: Date.now() - 20 * 60_000,
        })}
      />,
    );
    const meter = container.querySelector('[data-meter-pct="42"]');
    expect(meter?.className).toContain("opacity-50");
    // The marker is a descendant of the dimmed wrapper, so the stale fade
    // cascades to it — no separate opacity handling needed.
    expect(meter?.querySelector("[data-time-marker]")).not.toBeNull();
  });
});

describe("SubscriptionLimitsBadge auto refresh", () => {
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

  it("fetches fresh usage on mount when autoRefresh is set, scoped to the pill's route", async () => {
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    const init = refreshCalls()[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      routeId: "acct-anthropic",
    });
  });

  it("refreshes only the pressed account, not every connected subscription", async () => {
    // The regression this covers: the button used to post `{ agentId }` only,
    // so the server fanned the fetch out over every route. `/api/oauth/usage`
    // allows a handful of calls per ~30 min, so pressing the pill that showed
    // no numbers spent the other subscription's budget and locked it out too.
    useSettingsStore.getState().setProviderAccounts([
      { id: "acct-one", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Claude", status: "ready" },
      { id: "acct-two", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Claude2", status: "ready" },
    ] as never);
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap({ routeId: "acct-two" })) }} />);

    const buttons = screen.getAllByLabelText("Refresh subscription usage");
    expect(buttons).toHaveLength(2);
    buttons[0].click();
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    expect(JSON.parse((refreshCalls()[0][1] as RequestInit).body as string)).toEqual({
      serviceId: "anthropic",
    billingMode: "sub",
      routeId: "acct-one",
    });
  });

  it("explains a refresh that produced nothing instead of failing silently", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          results: [{ routeId: "acct-claude", outcome: "no-credentials" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    render(<SubscriptionLimitPill label="Claude" snapshot={makeSnap()} showRefresh />);
    const button = screen.getByLabelText("Refresh subscription usage");
    button.click();
    await waitFor(() =>
      expect(button.getAttribute("title")).toContain("no usable sign-in"),
    );
  });

  it("keeps the rate-limit countdown as the message when the route is locked out", async () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ lockedUntil: Date.now() + 10 * 60_000 })}
        showRefresh
      />,
    );
    const button = screen.getByLabelText("Refresh subscription usage");
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toContain("rate-limited");
  });

  it("does not fetch on mount without autoRefresh (the desktop header)", async () => {
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} />);
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("skips the fetch while the provider is locked out after a 429", async () => {
    render(
      <SubscriptionLimitsBadge
        limits={{ "anthropic:sub": routed(makeSnap({ lockedUntil: Date.now() + 10 * 60_000 })) }}
        autoRefresh
      />,
    );
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("does not fetch for a provider with no on-demand endpoint (Codex)", async () => {
    render(
      <SubscriptionLimitsBadge
        limits={{ "openai:sub": routed(makeSnap({ serviceId: "openai",
    billingMode: "sub", plan: "Plus" })) }}
        autoRefresh
      />,
    );
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("throttles repeated opens so re-opening the dropdown can't burn the budget", async () => {
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    // Closing the popover unmounts the badge; re-opening remounts it.
    cleanup();
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(1);
  });

  it("fetches again once the throttle interval has elapsed", async () => {
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    cleanup();

    const realNow = Date.now();
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(realNow + AUTO_REFRESH_MIN_INTERVAL_MS + 1);
    try {
      render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
      await waitFor(() => expect(refreshCalls()).toHaveLength(2));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("counts a manual button press against the auto-refresh throttle", async () => {
    const { unmount } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap()} showRefresh />,
    );
    screen.getByLabelText("Refresh subscription usage").click();
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    unmount();

    // Opening the dropdown right after a manual refresh shouldn't spend a
    // second call — the numbers are seconds old.
    render(<SubscriptionLimitsBadge limits={{ "anthropic:sub": routed(makeSnap()) }} autoRefresh />);
    await Promise.resolve();
    expect(refreshCalls()).toHaveLength(1);
  });
});
