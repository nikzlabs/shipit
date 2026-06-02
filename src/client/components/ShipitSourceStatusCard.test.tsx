import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ShipitSourceStatusCard } from "./ShipitSourceStatusCard.js";

/**
 * Tests for the Host-tab `ShipitSourceStatusCard` (docs/162).
 *
 * Informational, presentational component — the fetch lives in HostPanel and
 * is passed in as a prop. Tests cover the four render states: loading, error,
 * unavailable, and an available ref (exact vs. approximate).
 */

afterEach(cleanup);

describe("ShipitSourceStatusCard", () => {
  it("renders a loading state before the first fetch resolves", () => {
    render(<ShipitSourceStatusCard status={null} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders the fetch error inline", () => {
    render(<ShipitSourceStatusCard status={null} error="HTTP 403" />);
    expect(screen.getByTestId("shipit-source-status")).toHaveTextContent(/failed to read source status: HTTP 403/i);
  });

  it("renders the unavailable reason when source is unavailable", () => {
    render(
      <ShipitSourceStatusCard
        status={{ available: false, exact: false, reason: "Running source is unavailable." }}
      />,
    );
    expect(screen.getByTestId("shipit-source-unavailable")).toHaveTextContent("Running source is unavailable.");
  });

  it("renders an exact deployed commit with the short ref and exact badge", () => {
    render(
      <ShipitSourceStatusCard
        status={{
          available: true,
          ref: "abc123def456789",
          shortRef: "abc123def456",
          exact: true,
          refSource: "build-id",
          remoteUrl: "https://github.com/shipit-hq/shipit.git",
        }}
      />,
    );
    expect(screen.getByTestId("shipit-source-status")).toHaveTextContent("abc123def456");
    expect(screen.getByTestId("shipit-source-exactness")).toHaveTextContent(/exact/i);
    expect(screen.getByTestId("shipit-source-status")).toHaveTextContent("github.com/shipit-hq/shipit");
  });

  it("flags an approximate checkout-HEAD ref", () => {
    render(
      <ShipitSourceStatusCard
        status={{
          available: true,
          ref: "deadbeefcafe123",
          shortRef: "deadbeefcafe",
          exact: false,
          refSource: "checkout-head",
        }}
      />,
    );
    expect(screen.getByTestId("shipit-source-exactness")).toHaveTextContent(/approximate/i);
  });
});
