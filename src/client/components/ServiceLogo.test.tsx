/**
 * The vendor marks, pinned on what a type cannot say.
 *
 * "Every service has a mark" is NOT one of these tests, because `SERVICE_MARKS`
 * is total over `ServiceId` — the compiler already refuses a service without
 * one, and naming the missing id better than a test failure can. What is left
 * for a test is everything a `string` value satisfies and a logo does not: an
 * empty path, the same path pasted under two ids, a colour of its own (ShipIt is
 * multi-theme, and a hardcoded `#000` disappears on a dark background), and the
 * fallback for an id that is not a service at all.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { allServices } from "../../server/shared/catalogue/index.js";
import type { ServiceDef } from "../../server/shared/catalogue/index.js";
import { ServiceLogo } from "./ServiceLogo.js";

afterEach(cleanup);

describe("ServiceLogo", () => {
  /** The path each service draws, keyed by id — the basis of the two tests below. */
  const drawnPaths = (): Map<string, string> => {
    const drawn = new Map<string, string>();
    for (const service of allServices()) {
      const { container, unmount } = render(<ServiceLogo service={service} />);
      const svg = container.querySelector("svg");
      expect(svg, `no mark for ${service.id}`).not.toBeNull();
      // The 24×24 grid every Simple Icons path is drawn on. A mark copied in
      // under a different grid renders as a fragment of itself.
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      drawn.set(service.id, svg?.querySelector("path")?.getAttribute("d") ?? "");
      unmount();
    }
    return drawn;
  };

  it("draws a non-empty mark for every service ShipIt ships today", () => {
    for (const [id, path] of drawnPaths()) expect(path, `empty mark for ${id}`).toBeTruthy();
  });

  it("draws a DIFFERENT mark for each service", () => {
    // The failure this catches is a copy-paste: a new row added by duplicating
    // the one above it and changing only the key, which the compiler and every
    // other assertion here accept happily.
    const drawn = drawnPaths();
    expect(new Set(drawn.values()).size).toBe(drawn.size);
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
