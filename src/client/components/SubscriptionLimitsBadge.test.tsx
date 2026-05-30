import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  SubscriptionLimitsBadge,
  SubscriptionLimitPill,
  tierColor,
  formatPct,
  formatResetCountdown,
  formatAge,
  meterDisplay,
} from "./SubscriptionLimitsBadge.js";
import type { SubscriptionLimits, SubscriptionLimitsMap } from "../../server/shared/types.js";

afterEach(() => cleanup());

// Reset timestamps live in the future relative to the test clock so the
// meter doesn't collapse to 0 via the elapsed-reset rule (see
// `effectivePct`). Tests that want the elapsed behavior pass a past
// timestamp explicitly.
const FUTURE_SESSION_RESET = new Date(Date.now() + 60 * 60_000).toISOString();
const FUTURE_WEEKLY_RESET = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();

function makeSnap(overrides: Partial<SubscriptionLimits> = {}): SubscriptionLimits {
  return {
    agentId: "claude",
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
  it("renders nothing when the map is empty (no fetchable providers)", () => {
    const { container } = render(<SubscriptionLimitsBadge limits={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row for one provider", () => {
    const limits: SubscriptionLimitsMap = { claude: makeSnap() };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(/5h 30%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 50%/)).toBeInTheDocument();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("renders both rows in stable order: Claude then Codex", () => {
    const limits: SubscriptionLimitsMap = {
      // Map insertion order is reversed to confirm the component
      // doesn't naively use it.
      codex: makeSnap({ agentId: "codex", plan: "Plus", session: { usedPct: 10, resetAt: "x" }, weekly: { usedPct: 5, resetAt: "y" } }),
      claude: makeSnap({ agentId: "claude" }),
    };
    const { container } = render(<SubscriptionLimitsBadge limits={limits} />);
    const rows = container.querySelectorAll(":scope > span");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toMatch(/^Claude/);
    expect(rows[1].textContent).toMatch(/^Codex/);
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
    expect(screen.getByText(/5h 96%/)).toHaveTextContent(/resets in/);
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
    expect(screen.getByText(/7d 94%/)).toHaveTextContent(/resets in/);
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

  it("shows only the weekly meter when session is null", () => {
    render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: { usedPct: 40, resetAt: "x" } })}
      />,
    );
    expect(screen.queryByText(/5h/)).toBeNull();
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
    const fills = container.querySelectorAll<HTMLElement>("[aria-hidden]");
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
    const fills = container.querySelectorAll<HTMLElement>("[aria-hidden]");
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
    const fills = container.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(fills.length).toBe(1);
    // Weekly window is still open — unchanged.
    expect(screen.getByText(/7d 91%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 91%/)).toHaveTextContent(/resets in/);
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
    const fills = container.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(fills[0].style.width).toBe("100%");
    expect(fills[1].style.width).toBe("0%");
  });

  it("renders an em-dash when no windows are present", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ session: null, weekly: null })}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toContain("text-(--color-text-secondary)");
  });

  it("includes plan name in the tooltip when present", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ plan: "Max 20x" })} />,
    );
    expect(container.querySelector("span")?.getAttribute("title")).toContain("Max 20x");
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
    // No fill bar (`aria-hidden` is the fill div in the percentage path).
    expect(container.querySelector("[aria-hidden]")).toBeNull();
    // Tooltip explains the absence and points at the refresh button.
    expect(container.querySelector("span")?.getAttribute("title")).toContain(
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
});
