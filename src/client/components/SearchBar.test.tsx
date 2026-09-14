import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SearchBar } from "./SearchBar.js";

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof SearchBar>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <SearchBar
      query=""
      onQueryChange={vi.fn()}
      matches={[]}
      currentMatchIndex={0}
      onNext={vi.fn()}
      onPrev={vi.fn()}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { input: screen.getByPlaceholderText("Search messages...") as HTMLInputElement, onClose };
}

describe("SearchBar", () => {
  it("takes the cursor on mount, so remounting it under a new key re-focuses it", () => {
    const { input } = renderBar();
    expect(document.activeElement).toBe(input);
  });

  it("closes on Escape, as the close-overlay keybinding advertises", () => {
    const { input, onClose } = renderBar();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
