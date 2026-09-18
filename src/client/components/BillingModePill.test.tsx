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
    render(<BillingModePill billingMode="sub" data-testid="sub" />);
    render(<BillingModePill billingMode="key" data-testid="key" />);
    expect(screen.getByTestId("sub").className).toContain("--color-accent-subtle");
    expect(screen.getByTestId("key").className).toContain("--color-success-subtle");
    expect(screen.getByTestId("sub").className).toContain("rounded-full");
  });

  it("keeps its own casing inside an uppercase parent", () => {
    // Text assertions cannot detect CSS case transforms.
    render(
      <DropdownMenuLabel>
        <BillingModePill billingMode="sub" data-testid="sub" />
      </DropdownMenuLabel>,
    );
    expect(screen.getByTestId("sub").className).toContain("normal-case");
    expect(screen.getByTestId("sub").className).toContain("tracking-normal");
  });
});
