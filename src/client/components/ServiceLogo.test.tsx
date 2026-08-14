/**
 * The vendor marks, pinned on the two things that would silently regress: a
 * service the map does not cover must still draw *something*, and no mark may
 * carry a colour of its own (ShipIt is multi-theme, and a hardcoded `#000`
 * disappears on a dark background).
 *
 * Deliberately NOT asserting that every catalogue service has a mark. The map is
 * `Partial` on purpose — a new service ships before its artwork does, and a red
 * build over a missing logo would be the fallback's whole reason for existing,
 * inverted.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { allServices } from "../../server/shared/catalogue/index.js";
import type { ServiceDef } from "../../server/shared/catalogue/index.js";
import { ServiceLogo } from "./ServiceLogo.js";

afterEach(cleanup);

describe("ServiceLogo", () => {
  it("draws a mark for every service ShipIt ships today", () => {
    for (const service of allServices()) {
      const { container, unmount } = render(<ServiceLogo service={service} />);
      const svg = container.querySelector("svg");
      expect(svg, `no mark for ${service.id}`).not.toBeNull();
      expect(svg?.querySelector("path")?.getAttribute("d")).toBeTruthy();
      unmount();
    }
  });

  it("draws every mark in currentColor, so it survives a theme change", () => {
    for (const service of allServices()) {
      const { container, unmount } = render(<ServiceLogo service={service} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("fill")).toBe("currentColor");
      // A path with its own fill would defeat the svg-level one.
      expect(svg?.querySelector("path")?.getAttribute("fill")).toBeNull();
      unmount();
    }
  });

  it("falls back to the initial for a service with no artwork yet", () => {
    const unknown = { id: "brand-new", name: "Newcomer", modes: [] } as unknown as ServiceDef;
    const { container } = render(<ServiceLogo service={unknown} />);

    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("N")).toBeInTheDocument();
  });

  it("says nothing to a screen reader — the service name is always beside it", () => {
    const anthropic = allServices().find((s) => s.id === "anthropic")!;
    const { container } = render(<ServiceLogo service={anthropic} />);

    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
