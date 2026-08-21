/**
 * docs/252 — the billing-mode pill.
 *
 * The component exists so Settings and the composer's model menu cannot make
 * the same statement two different ways, so what is pinned here is exactly the
 * contract that reuse depends on: the two labels, the two colours, and — the
 * one that actually broke — that it looks the same inside a parent with its own
 * typography.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BillingModePill, MODE_LABEL } from "./BillingModePill.js";
import { DropdownMenuLabel } from "./ui/dropdown-menu.js";

afterEach(cleanup);

describe("BillingModePill", () => {
  it("names a subscription and a key the way the catalogue does", () => {
    render(<BillingModePill billingMode="sub" data-testid="sub" />);
    render(<BillingModePill billingMode="key" data-testid="key" />);
    expect(screen.getByTestId("sub")).toHaveTextContent(MODE_LABEL.sub);
    expect(screen.getByTestId("key")).toHaveTextContent(MODE_LABEL.key);
  });

  it("tints a subscription with the accent and a key with success", () => {
    // Two colours, both semantic tokens — the mock's purple/green pair reads as
    // whatever the active theme's accent and success are.
    render(<BillingModePill billingMode="sub" data-testid="sub" />);
    render(<BillingModePill billingMode="key" data-testid="key" />);
    expect(screen.getByTestId("sub").className).toContain("--color-accent-subtle");
    expect(screen.getByTestId("key").className).toContain("--color-success-subtle");
    expect(screen.getByTestId("sub").className).toContain("rounded-full");
  });

  it("keeps its own casing inside an uppercase parent", () => {
    // The regression this pins: the model menu nests the pill inside
    // `DropdownMenuLabel`, which is `uppercase tracking-wider`. The pill
    // inherited it and read "SUBSCRIPTION" in the menu while the service card
    // said "Subscription" — one statement, two appearances, which is the thing
    // sharing the component was supposed to rule out. `toHaveTextContent` reads
    // source text and cannot see a CSS transform, so the class is the assertion.
    render(
      <DropdownMenuLabel>
        <BillingModePill billingMode="sub" data-testid="sub" />
      </DropdownMenuLabel>,
    );
    expect(screen.getByTestId("sub").className).toContain("normal-case");
    expect(screen.getByTestId("sub").className).toContain("tracking-normal");
  });
});
