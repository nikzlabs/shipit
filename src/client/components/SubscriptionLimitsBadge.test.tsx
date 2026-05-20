import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  SubscriptionLimitsBadge,
  SubscriptionLimitPill,
  tierColor,
  formatPct,
} from "./SubscriptionLimitsBadge.js";
import type { SubscriptionLimits, SubscriptionLimitsMap } from "../../server/shared/types.js";

afterEach(() => cleanup());

function makeSnap(overrides: Partial<SubscriptionLimits> = {}): SubscriptionLimits {
  return {
    agentId: "claude",
    plan: "Pro",
    session: { usedPct: 30, resetAt: "2026-05-19T18:00:00Z" },
    weekly: { usedPct: 50, resetAt: "2026-05-26T00:00:00Z" },
    weeklyOpus: null,
    fetchedAt: Date.parse("2026-05-19T12:00:00Z"),
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
          session: { usedPct: 96, resetAt: "2026-05-19T17:00:00Z" },
          weekly: { usedPct: 22, resetAt: "2026-05-26T00:00:00Z" },
        })}
      />,
    );
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(/5h 96%/)).toBeInTheDocument();
    expect(screen.getByText(/7d 22%/)).toBeInTheDocument();
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
