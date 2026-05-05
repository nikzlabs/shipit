import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryPressureBanner } from "./MemoryPressureBanner.js";

afterEach(cleanup);

const GiB = 1024 * 1024 * 1024;

describe("MemoryPressureBanner", () => {
  it("renders nothing when stats are null", () => {
    const { container } = render(<MemoryPressureBanner stats={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when totalBytes is zero (Docker stats unavailable)", () => {
    const { container } = render(<MemoryPressureBanner stats={{ usedBytes: GiB, totalBytes: 0 }} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing below the banner threshold (50% used)", () => {
    const { container } = render(
      <MemoryPressureBanner stats={{ usedBytes: 8 * GiB, totalBytes: 16 * GiB }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing at 79% (just under 80% threshold)", () => {
    const { container } = render(
      <MemoryPressureBanner stats={{ usedBytes: 0.79 * 16 * GiB, totalBytes: 16 * GiB }} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the warning tone at 80% (just at threshold)", () => {
    render(<MemoryPressureBanner stats={{ usedBytes: 0.80 * 16 * GiB, totalBytes: 16 * GiB }} />);
    const banner = screen.getByTestId("memory-pressure-banner");
    expect(banner.className).toContain("color-warning");
    expect(banner.className).not.toContain("color-error");
    expect(banner.textContent).toMatch(/12\.8 GiB \/ 16\.0 GiB \(80%\)/);
  });

  it("renders the warning tone at 89%", () => {
    render(<MemoryPressureBanner stats={{ usedBytes: 0.89 * 16 * GiB, totalBytes: 16 * GiB }} />);
    const banner = screen.getByTestId("memory-pressure-banner");
    expect(banner.className).toContain("color-warning");
    expect(banner.className).not.toContain("color-error");
  });

  it("escalates to error tone at 90%+", () => {
    render(<MemoryPressureBanner stats={{ usedBytes: 0.95 * 16 * GiB, totalBytes: 16 * GiB }} />);
    const banner = screen.getByTestId("memory-pressure-banner");
    expect(banner.className).toContain("color-error");
    // Critical message wording — distinct from the warning case.
    expect(banner.textContent).toMatch(/near OOM/i);
  });

  it("renders an alert role for assistive tech", () => {
    render(<MemoryPressureBanner stats={{ usedBytes: 0.95 * 16 * GiB, totalBytes: 16 * GiB }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
