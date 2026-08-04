import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Banner, Alert } from "./banner.js";

afterEach(() => {
  cleanup();
});

describe("Banner (strip layout)", () => {
  it("renders a centered, borderless strip with the variant color tokens", () => {
    const { container } = render(<Banner variant="error">Boom</Banner>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("text-center");
    expect(el.className).toContain("bg-(--color-error-subtle)");
    expect(el.className).toContain("text-(--color-error)");
    // No border width is applied in the strip layout.
    expect(el.className).not.toMatch(/(?:^|\s)border(?:\s|$)/);
  });

  it("defaults to the info variant", () => {
    const { container } = render(<Banner>Hi</Banner>);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "bg-(--color-info-subtle)",
    );
  });
});

describe("Alert (inline layout)", () => {
  it("renders a left-aligned, bordered callout reusing the variant color tokens", () => {
    const { container } = render(<Alert variant="warning">Heads up</Alert>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("flex");
    expect(el.className).toContain("items-start");
    expect(el.className).toContain("rounded-md");
    expect(el.className).toContain("border");
    // Same color-token mapping as Banner — not a duplicated set.
    expect(el.className).toContain("bg-(--color-warning-subtle)");
    expect(el.className).toContain("text-(--color-warning)");
    expect(el.className).toContain("border-(--color-warning)");
    // It is not the centered strip.
    expect(el.className).not.toContain("text-center");
  });

  it("lets a caller className override conflicting utilities via twMerge", () => {
    const { container } = render(
      <Alert variant="error" className="items-center p-3 text-sm">
        x
      </Alert>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("items-center");
    expect(el.className).not.toContain("items-start");
    expect(el.className).toContain("p-3");
    expect(el.className).not.toContain("px-3");
    expect(el.className).toContain("text-sm");
    expect(el.className).not.toContain("text-xs");
  });

  it("forwards arbitrary props such as data-testid and children", () => {
    const { getByTestId } = render(
      <Alert variant="warning" data-testid="my-alert">
        <span>icon</span>
        <p>body</p>
      </Alert>,
    );
    const el = getByTestId("my-alert");
    expect(el.textContent).toBe("iconbody");
  });
});
