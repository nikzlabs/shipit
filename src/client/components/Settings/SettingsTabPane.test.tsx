/**
 * The one behaviour worth pinning here is structural: the Save button must sit
 * OUTSIDE the scrolling body, so it stays visible however long the form gets.
 * A footer rendered at the end of the scroll area looks identical in a static
 * DOM assertion but scrolls out of reach in the browser — hence the check that
 * the button is not a descendant of the element that scrolls.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SettingsTabPane } from "./SettingsTabPane.js";
import { GitTab } from "./tabs/GitTab.js";
import { InstructionsTab } from "./tabs/InstructionsTab.js";
import { createRef } from "react";

afterEach(cleanup);

/** The scrolling element of a tab pane: the pane root's first child. */
function scrollBodyOf(root: HTMLElement): HTMLElement {
  const body = root.firstElementChild as HTMLElement;
  expect(body.className).toContain("overflow-y-auto");
  return body;
}

describe("SettingsTabPane", () => {
  it("renders the footer outside the scrolling body", () => {
    render(
      <SettingsTabPane testId="pane" footer={<button>Save</button>}>
        <p>body content</p>
      </SettingsTabPane>,
    );

    const pane = screen.getByTestId("pane");
    const body = scrollBodyOf(pane);
    const save = screen.getByRole("button", { name: "Save" });

    expect(body).toContainElement(screen.getByText("body content"));
    expect(body).not.toContainElement(save);
    expect(pane).toContainElement(save);
  });

  it("omits the footer when no actions are given", () => {
    render(
      <SettingsTabPane testId="pane">
        <p>body content</p>
      </SettingsTabPane>,
    );
    expect(screen.getByTestId("pane").children).toHaveLength(1);
  });
});

describe("tab Save buttons stay pinned", () => {
  it("Git identity Save is outside the scroll area", () => {
    const { container } = render(
      <GitTab gitIdentity={{ name: "A", email: "a@example.com" }} onGitIdentitySave={() => {}} />,
    );
    const pane = container.firstElementChild as HTMLElement;
    expect(scrollBodyOf(pane)).not.toContainElement(screen.getByTestId("settings-git-save"));
  });

  it("Instructions Save is outside the scroll area", () => {
    const { container } = render(
      <InstructionsTab
        content=""
        onContentChange={() => {}}
        textareaRef={createRef<HTMLTextAreaElement>()}
        onSave={() => {}}
        onClose={() => {}}
        agentSystemInstructionsEnabled
        agentSystemInstructions=""
        onToggleAgentSystemInstructions={() => {}}
      />,
    );
    const pane = container.firstElementChild as HTMLElement;
    expect(scrollBodyOf(pane)).not.toContainElement(screen.getByTestId("settings-save"));
  });
});
