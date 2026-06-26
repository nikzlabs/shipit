import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Avatar } from "./avatar.js";

afterEach(() => {
  cleanup();
});

describe("Avatar", () => {
  it("renders an <img> when avatarUrl is present", () => {
    render(<Avatar name="Ada Lovelace" avatarUrl="https://example.com/a.png" />);
    const img = screen.getByRole("img");
    expect(img).toHaveProperty("src", "https://example.com/a.png");
    expect(img.className).toContain("rounded-full");
    expect(img.getAttribute("loading")).toBe("lazy");
    // No initials text is rendered on the image branch.
    expect(screen.queryByText("A")).toBeNull();
  });

  it("falls back to a first-character initials circle when avatarUrl is absent", () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
  });

  it("renders '?' for the default initials when the name is empty", () => {
    render(<Avatar name="" />);
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("uses a custom getInitials (first-of-each-word)", () => {
    const initials = (name: string) => {
      const parts = name.trim().split(/\s+/).filter(Boolean);
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    };
    render(<Avatar name="Ada Lovelace" getInitials={initials} />);
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("applies the pixel size as inline width/height", () => {
    render(<Avatar name="Ada" size={18} />);
    const circle = screen.getByText("A");
    expect(circle.style.width).toBe("18px");
    expect(circle.style.height).toBe("18px");
  });

  it("merges className overrides onto the fallback circle", () => {
    render(<Avatar name="Ada" className="bg-(--color-bg-hover)" />);
    const circle = screen.getByText("A");
    // twMerge keeps the override and drops the conflicting default bg.
    expect(circle.className).toContain("bg-(--color-bg-hover)");
    expect(circle.className).not.toContain("bg-(--color-bg-tertiary)");
  });

  it("defaults the image alt text to the name", () => {
    render(<Avatar name="Ada Lovelace" avatarUrl="https://example.com/a.png" />);
    expect(screen.getByAltText("Ada Lovelace")).toBeTruthy();
  });
});
