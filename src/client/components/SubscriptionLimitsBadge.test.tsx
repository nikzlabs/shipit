import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  SubscriptionLimitsBadge,
  SubscriptionLimitPill,
  tierColor,
  formatPct,
  formatResetCountdown,
  effectivePct,
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
    weeklyOpus: null,
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

describe("effectivePct", () => {
  it("returns the cached pct while the window is still open", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(effectivePct(96, "2026-05-19T17:00:00Z", now)).toBe(96);
  });

  it("collapses to 0 once the reset timestamp has elapsed", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(effectivePct(100, "2026-05-19T11:59:00Z", now)).toBe(0);
    expect(effectivePct(100, "2026-05-19T12:00:00Z", now)).toBe(0);
  });

  it("preserves the cached pct when resetAt is unparseable", () => {
    const now = Date.parse("2026-05-19T12:00:00Z");
    expect(effectivePct(73, "not-a-date", now)).toBe(73);
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

  it("shows 0% (no countdown) once the meter's resetAt has elapsed", () => {
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
    // 5h window has elapsed → meter snaps to 0%, no "resets in now" text.
    expect(screen.getByText(/5h 0%/)).toBeInTheDocument();
    expect(screen.queryByText(/5h 100%/)).toBeNull();
    expect(screen.getByText(/5h 0%/)).not.toHaveTextContent(/resets in/);
    // Weekly window is still open — unchanged.
    expect(screen.getByText(/7d 91%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 91%/)).toHaveTextContent(/resets in/);
    // The post-reset meter also re-tiers (was full, now neutral) and
    // its fill collapses to 0%.
    const fills = container.querySelectorAll<HTMLElement>("[aria-hidden]");
    expect(fills[0].style.width).toBe("0%");
    expect(fills[0].style.backgroundColor).toContain("--color-text-secondary");
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

  it("renders the neutral em-dash form when error has no prior data", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({ error: "auth expired", session: null, weekly: null })}
      />,
    );
    expect(screen.getByText("Claude —")).toBeInTheDocument();
    expect(container.querySelector("span")?.getAttribute("title")).toContain("auth expired");
  });

  it("keeps stale meters visually identical, surfacing the reason only in the tooltip", () => {
    const { container } = render(
      <SubscriptionLimitPill
        label="Claude"
        snapshot={makeSnap({
          error: "rate limited",
          session: { usedPct: 96, resetAt: "x" },
          weekly: { usedPct: 22, resetAt: "y" },
        })}
      />,
    );
    // Meters still render at full strength.
    expect(screen.getByText(/5h 96%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 22%/)).toBeInTheDocument();
    const row = container.querySelector("[data-stale=\"true\"]");
    expect(row).not.toBeNull();
    // No dimming — the user's read of "this is the right number" matters
    // more than signalling that the refresh hiccup happened.
    expect(row?.className).not.toContain("opacity-60");
    expect(row?.getAttribute("title")).toMatch(/Last refresh failed.*rate limited/);
  });

  it("error pill has no tier color", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ error: "limits unavailable", session: null, weekly: null })} />,
    );
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-(--color-text-secondary)");
    expect(span?.className).not.toContain("--color-context-full");
  });

  it("includes plan name in the tooltip when present", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ plan: "Max 20x" })} />,
    );
    expect(container.querySelector("span")?.getAttribute("title")).toContain("Max 20x");
  });
});
