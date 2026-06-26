import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Button } from "./button.js";

afterEach(cleanup);

describe("Button size variants", () => {
  it("applies the icon size's square padding", () => {
    render(
      <Button size="icon" aria-label="close">
        x
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "close" });
    // The `icon` size is padding-based (square) with no fixed height, so it sizes
    // to its glyph — this is what lets one size cover both icon-only and tight
    // icon+label buttons.
    expect(btn.className).toContain("p-1");
    expect(btn.className).not.toMatch(/\bh-8\b/);
  });

  it("defaults to the md size when size is omitted", () => {
    render(<Button aria-label="save">save</Button>);
    const btn = screen.getByRole("button", { name: "save" });
    expect(btn.className).toContain("h-8");
  });

  it("pairs icon size with the ghost variant's hover-fill tokens", () => {
    render(
      <Button variant="ghost" size="icon" aria-label="edit">
        e
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "edit" });
    // The adopted icon-button sites rely on ghost owning the hover background +
    // text-color transition that they used to hand-roll.
    expect(btn.className).toContain("p-1");
    expect(btn.className).toContain("hover:bg-(--color-bg-hover)");
  });

  it("lets a caller className override the icon size's padding via twMerge", () => {
    // The label-remove chip needs a round, zero-padding shape — the override must
    // win over the size's `p-1`.
    render(
      <Button size="icon" className="p-0 size-3.5 rounded-full" aria-label="remove">
        x
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "remove" });
    expect(btn.className).toContain("p-0");
    expect(btn.className).not.toMatch(/\bp-1\b/);
    expect(btn.className).toContain("rounded-full");
  });
});
