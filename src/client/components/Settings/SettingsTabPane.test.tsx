/**
 * A tab's Save must stay in sight however long the form gets. It used to do so
 * by sitting OUTSIDE the scrolling body, in this pane's footer; the renderer
 * places it now, so it lives INSIDE the scroll area and sticks to the bottom of
 * it.
 *
 * jsdom measures no layout, so what is checked here is that the bar is in the
 * scrolling body and carries the offsets that stick it — not that it ends up
 * visible, which was checked in a browser.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GitTab } from "./tabs/GitTab.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { useSettingsStore } from "../../stores/settings-store.js";

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ agentSystemInstructions: "" });
});

function scrollBodyOf(root: HTMLElement): HTMLElement {
  const body = root.firstElementChild as HTMLElement;
  expect(body.className).toContain("overflow-y-auto");
  return body;
}

/** The Save's own bar, which is what has to stick. */
function barOf(): HTMLElement {
  return screen.getByRole("button", { name: "Save" }).closest<HTMLElement>(".sticky")!;
}

describe("tab Save buttons stay in sight", () => {
  it.each([
    ["Git identity", <GitTab key="git" />],
    ["Instructions", <InstructionsTab key="instructions" />],
  ])("%s Save sticks to the bottom of the scroll area", (_name, tab) => {
    const { container } = render(tab);
    const body = scrollBodyOf(container.firstElementChild as HTMLElement);

    expect(body).toContainElement(barOf());
    expect(barOf().className).toContain("-bottom-4");
  });

  // The built-in instructions are the toggle's own row note, so they sit under
  // the control that shows them and inside the block rather than after the bar.
  it("comes after the built-in instructions, which sit under their toggle", () => {
    useSettingsStore.setState({ agentSystemInstructions: "Built-in context." });
    render(<InstructionsTab />);

    const toggle = screen.getByRole("switch", { name: "ShipIt Agent Instructions" });
    const disclosure = screen.getByTestId("agent-system-instructions");
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    expect(follows(toggle, disclosure)).toBe(true);
    expect(follows(disclosure, barOf())).toBe(true);
  });
});
