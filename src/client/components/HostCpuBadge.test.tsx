import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HostCpuBadge } from "./HostCpuBadge.js";

afterEach(cleanup);

describe("HostCpuBadge", () => {
  it("shows the load and the core count", () => {
    render(<HostCpuBadge stats={{ usedPercent: 14.6, cores: 16 }} />);

    const pill = screen.getByText("CPU 15% / 16 cores");
    expect(pill).toHaveAttribute("title", "Machine CPU load: 15% of 16 cores, all cores together");
  });

  it("does not pluralize a single core", () => {
    render(<HostCpuBadge stats={{ usedPercent: 3, cores: 1 }} />);

    expect(screen.getByText("CPU 3% / 1 core")).toBeInTheDocument();
  });

  it.each([
    [59.4, "text-(--color-text-secondary)"],
    [60, "text-(--color-warning)"],
    [89.4, "text-(--color-warning)"],
    [89.6, "text-(--color-error)"],
    [100, "text-(--color-error)"],
  ])("colors %s%% by the figure it displays", (usedPercent, colorClass) => {
    render(<HostCpuBadge stats={{ usedPercent, cores: 8 }} />);

    expect(screen.getByText(/^CPU /)).toHaveClass(colorClass);
  });
});
