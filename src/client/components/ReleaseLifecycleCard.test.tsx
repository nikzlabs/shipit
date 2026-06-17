import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ReleaseLifecycleCard } from "./ReleaseLifecycleCard.js";
import type { ReleaseStatusSummary } from "../../server/shared/types.js";

/**
 * Tests for the persisted release transcript card (docs/171). The card renders
 * straight from its `card` snapshot: `proposed` is the expanded interactive form
 * (Confirm/Cancel); every later phase collapses to a compact row. A one-shot
 * guard prevents a double confirm while the agent's follow-up turn is in flight.
 */
function card(over: Partial<ReleaseStatusSummary> = {}): ReleaseStatusSummary {
  return {
    sessionId: "s1",
    cardId: "release:s1:v0.3.0",
    phase: "proposed",
    version: "0.3.0",
    tag: "v0.3.0",
    prerelease: false,
    bumpType: "minor",
    ...over,
  };
}

afterEach(() => cleanup());

describe("ReleaseLifecycleCard — proposed", () => {
  it("renders Confirm & Cancel and the proposed label", () => {
    render(<ReleaseLifecycleCard card={card()} />);
    expect(screen.getByText("Release proposed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm & publish/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Cancel$/ })).toBeInTheDocument();
  });

  it("confirms exactly once even on repeated clicks (double-send guard)", () => {
    const onConfirm = vi.fn();
    render(<ReleaseLifecycleCard card={card()} onConfirm={onConfirm} />);
    const btn = screen.getByRole("button", { name: /Confirm & publish/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("0.3.0");
  });

  it("cancel fires once and passes the version", () => {
    const onCancel = vi.fn();
    render(<ReleaseLifecycleCard card={card()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("0.3.0");
  });
});

describe("ReleaseLifecycleCard — collapsed", () => {
  it("collapses (no Confirm button) once cancelled", () => {
    render(<ReleaseLifecycleCard card={card({ phase: "cancelled" })} />);
    expect(screen.getByText("Release cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm & publish/ })).not.toBeInTheDocument();
  });

  it("collapses to a released row with the published-release link", () => {
    render(
      <ReleaseLifecycleCard
        card={card({
          phase: "released",
          release: {
            name: "v0.3.0",
            body: "notes",
            htmlUrl: "https://github.com/o/r/releases/tag/v0.3.0",
            prerelease: false,
            publishedAt: null,
            tagName: "v0.3.0",
          },
        })}
      />,
    );
    expect(screen.getByText("Released")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm & publish/ })).not.toBeInTheDocument();
  });

  it("shows the error message on a failed release", () => {
    render(<ReleaseLifecycleCard card={card({ phase: "failed", errorMessage: "Release gate failed (1 of 2 checks failed)." })} />);
    expect(screen.getByText("Release failed")).toBeInTheDocument();
    expect(screen.getByText(/Release gate failed/)).toBeInTheDocument();
  });
});
