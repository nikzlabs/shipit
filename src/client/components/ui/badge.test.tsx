import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Badge } from "./badge.js";

afterEach(cleanup);

describe("Badge", () => {
  it("renders the default variant when none is given", () => {
    render(<Badge>Default</Badge>);
    const el = screen.getByText("Default");
    expect(el.className).toContain("bg-(--color-bg-tertiary)");
    expect(el.className).toContain("text-(--color-text-secondary)");
  });

  it("applies semantic variant colors", () => {
    render(<Badge variant="error">Err</Badge>);
    const el = screen.getByText("Err");
    expect(el.className).toContain("bg-(--color-error-subtle)");
    expect(el.className).toContain("text-(--color-error)");
  });

  it("adds tabular-nums only when numeric", () => {
    render(<Badge numeric>123</Badge>);
    expect(screen.getByText("123").className).toContain("tabular-nums");

    cleanup();
    render(<Badge>123</Badge>);
    expect(screen.getByText("123").className).not.toContain("tabular-nums");
  });

  it("lets a caller's className override conflicting variant utilities", () => {
    // The metric/status header chips (UptimeBadge, DockerMemoryBadge,
    // SubscriptionLimitsBadge) ride on this: a custom background must win over
    // the variant default, which only works because Badge merges via twMerge.
    render(
      <Badge className="bg-(--color-bg-hover)">Chip</Badge>,
    );
    const el = screen.getByText("Chip");
    expect(el.className).toContain("bg-(--color-bg-hover)");
    expect(el.className).not.toContain("bg-(--color-bg-tertiary)");
  });

  it("overrides the text color while keeping the variant background", () => {
    // DockerMemoryBadge keeps a constant background and only swaps the text
    // color by severity (e.g. text-(--color-error)).
    render(
      <Badge className="bg-(--color-bg-hover) text-(--color-error)">Mem</Badge>,
    );
    const el = screen.getByText("Mem");
    expect(el.className).toContain("text-(--color-error)");
    expect(el.className).not.toContain("text-(--color-text-secondary)");
  });

  it("forwards arbitrary span attributes like title", () => {
    render(<Badge title="tooltip">Hov</Badge>);
    expect(screen.getByText("Hov").getAttribute("title")).toBe("tooltip");
  });
});
