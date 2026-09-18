/**
 * `PickerOption`'s `leading` slot — the left-edge glyph the service rows draw
 * their vendor mark in.
 *
 * The slot is one `&&` and would need no test of its own, except for the thing
 * it is easy to get wrong and impossible to see in a unit render of the caller:
 * a row WITHOUT a glyph must not reserve the space for one. Every menu in ShipIt
 * mixes the two — services have marks, models and harnesses do not — so a slot
 * that always occupied its box would indent every row in the product to make
 * room for a column of nothing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Picker, PickerOption } from "./Picker.js";

afterEach(cleanup);

async function openWith(option: React.ReactNode): Promise<void> {
  const user = userEvent.setup();
  render(
    <Picker label="Pick" ariaLabel="Pick" triggerTestId="trigger">
      {option}
    </Picker>,
  );
  await user.click(screen.getByTestId("trigger"));
}

describe("PickerOption leading slot", () => {
  it("draws the glyph before the label", async () => {
    await openWith(
      <PickerOption
        label="Anthropic"
        leading={<svg data-testid="mark" aria-hidden="true" />}
        onSelect={() => {}}
        testId="row"
      />,
    );

    const row = screen.getByTestId("row");
    const mark = screen.getByTestId("mark");
    expect(row).toContainElement(mark);

    expect(
      mark.compareDocumentPosition(screen.getByText("Anthropic"))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reserves no space when there is no glyph", async () => {
    await openWith(<PickerOption label="Opus 5" onSelect={() => {}} testId="row" />);

    const row = screen.getByTestId("row");
    expect(row.querySelector("svg")).toBeNull();

    expect(row.firstElementChild).toHaveTextContent("Opus 5");
  });
});
