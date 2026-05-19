import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  SubscriptionLimitsBadge,
  SubscriptionLimitPill,
  colorClassFor,
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

describe("colorClassFor", () => {
  it("uses secondary text under 60%", () => {
    expect(colorClassFor(0)).toBe("text-(--color-text-secondary)");
    expect(colorClassFor(59.9)).toBe("text-(--color-text-secondary)");
  });

  it("yellows the 60-74% band", () => {
    expect(colorClassFor(60)).toBe("text-yellow-400");
    expect(colorClassFor(74.9)).toBe("text-yellow-400");
  });

  it("oranges the 75-89% band", () => {
    expect(colorClassFor(75)).toBe("text-orange-400");
    expect(colorClassFor(89.9)).toBe("text-orange-400");
  });

  it("reds 90% and above", () => {
    expect(colorClassFor(90)).toBe("text-red-400");
    expect(colorClassFor(100)).toBe("text-red-400");
  });
});

describe("SubscriptionLimitsBadge group", () => {
  it("renders nothing when the map is empty (no fetchable providers)", () => {
    const { container } = render(<SubscriptionLimitsBadge limits={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one pill for one provider", () => {
    const limits: SubscriptionLimitsMap = { claude: makeSnap() };
    render(<SubscriptionLimitsBadge limits={limits} />);
    expect(screen.getByText(/Claude 5h 30% · 7d 50%/)).toBeInTheDocument();
    expect(screen.queryByText(/Codex/)).toBeNull();
  });

  it("renders both pills in stable order: Claude then Codex", () => {
    const limits: SubscriptionLimitsMap = {
      // Map insertion order is reversed to confirm the component
      // doesn't naively use it.
      codex: makeSnap({ agentId: "codex", plan: "Plus", session: { usedPct: 10, resetAt: "x" }, weekly: { usedPct: 5, resetAt: "y" } }),
      claude: makeSnap({ agentId: "claude" }),
    };
    const { container } = render(<SubscriptionLimitsBadge limits={limits} />);
    const pills = container.querySelectorAll("span");
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toMatch(/^Claude /);
    expect(pills[1].textContent).toMatch(/^Codex /);
  });
});

describe("SubscriptionLimitPill", () => {
  it("renders session and weekly numbers when both present", () => {
    render(<SubscriptionLimitPill label="Claude" snapshot={makeSnap({ session: { usedPct: 96, resetAt: "2026-05-19T17:00:00Z" }, weekly: { usedPct: 22, resetAt: "2026-05-26T00:00:00Z" } })} />);
    expect(screen.getByText("Claude 5h 96% · 7d 22%")).toBeInTheDocument();
  });

  it("shows only weekly when session is null", () => {
    render(<SubscriptionLimitPill label="Claude" snapshot={makeSnap({ session: null, weekly: { usedPct: 40, resetAt: "x" } })} />);
    expect(screen.getByText("Claude 7d 40%")).toBeInTheDocument();
  });

  it("color is driven by the weekly value when ≥10%", () => {
    // Session at 100%, weekly at 80% → orange (driven by weekly).
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ session: { usedPct: 100, resetAt: "x" }, weekly: { usedPct: 80, resetAt: "y" } })} />,
    );
    expect(container.querySelector("span")?.className).toContain("text-orange-400");
  });

  it("color falls back to session when weekly is trivial (<10%)", () => {
    // Session 65% (yellow), weekly 2% (trivial) → yellow.
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ session: { usedPct: 65, resetAt: "x" }, weekly: { usedPct: 2, resetAt: "y" } })} />,
    );
    expect(container.querySelector("span")?.className).toContain("text-yellow-400");
  });

  it("renders the neutral em-dash form on error", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ error: "auth expired" })} />,
    );
    expect(screen.getByText("Claude —")).toBeInTheDocument();
    // Error tooltip surfaces the reason.
    expect(container.querySelector("span")?.getAttribute("title")).toContain("auth expired");
  });

  it("error pill has no color tier", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ error: "limits unavailable", session: null, weekly: null })} />,
    );
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-(--color-text-secondary)");
    expect(span?.className).not.toContain("text-red-400");
  });

  it("includes plan name in the tooltip when present", () => {
    const { container } = render(
      <SubscriptionLimitPill label="Claude" snapshot={makeSnap({ plan: "Max 20x" })} />,
    );
    expect(container.querySelector("span")?.getAttribute("title")).toContain("Max 20x");
  });
});
