/**
 * A tab's Save must stay in sight however long the form gets. It used to do so
 * by sitting OUTSIDE the scrolling body, in this pane's footer; the renderer
 * places it now, so it lives INSIDE the scroll area and sticks to the bottom of
 * it. The rendered tabs are here rather than in the renderer's own tests because
 * what is being checked is the pane the block sits in.
 *
 * Sticking is the one thing jsdom cannot measure, so the bar is asserted rather
 * than the position it produces.
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

  /*
    The bar covers whatever follows it for the length of the scroll, so the
    built-in instructions — the one thing on either tab that used to — are the
    toggle's own row note now, under the control that enables them and above the
    bar rather than below it.
  */
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
