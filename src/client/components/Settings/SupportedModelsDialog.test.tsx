/**
 * docs/252 reqs 23–24 — the supported-models dialog.
 *
 * The behaviours worth pinning are the ones that come from the requirements
 * rather than from the layout: the list covers the whole catalogue (not the
 * configured services), a model's harness support is a SET, a harness this
 * deployment lacks keeps its column and is marked, and narrowing to one harness
 * hides what it cannot run everywhere at once while saying so.
 *
 * The catalogue is a module constant, so these assert against the real rows.
 * Deliberately: the per-model harness answer is the one thing here that must not
 * drift from `eligibleEntriesForHarness`, and a fixture catalogue is exactly how
 * a test comes to pass over an answer the app gets wrong.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { allServices } from "../../../server/shared/catalogue/index.js";
import { SupportedModelsDialog } from "./SupportedModelsDialog.js";

const claudeAgent = {
  id: "claude" as const,
  name: "Claude",
  installed: true,
  hasRunnableModels: true,
  models: [],
  supportsReview: true,
};
const codexAgent = { ...claudeAgent, id: "codex" as const, name: "Codex" };

/** Claude Code and Codex installed, OpenCode not — the dogfood image's shape. */
const AGENTS = [claudeAgent, codexAgent];

function open(props: Partial<Parameters<typeof SupportedModelsDialog>[0]> = {}) {
  return render(
    <SupportedModelsDialog agentList={AGENTS} onClose={() => {}} {...props} />,
  );
}

/** A row's harness cells, keyed by harness id. */
function cellsFor(modelId: string) {
  return {
    claude: screen.getAllByTestId(`supported-models-cell-${modelId}-claude`),
    codex: screen.getAllByTestId(`supported-models-cell-${modelId}-codex`),
    opencode: screen.getAllByTestId(`supported-models-cell-${modelId}-opencode`),
  };
}

describe("SupportedModelsDialog", () => {
  afterEach(cleanup);

  it("lists every service in the catalogue, not only the configured ones", () => {
    // req 23's whole point: the question is asked BEFORE a credential exists, so
    // a service the user has never touched must still be here.
    open({ configuredServiceIds: new Set(["anthropic"]) });
    for (const service of allServices()) {
      expect(screen.getByTestId(`supported-models-service-${service.id}`)).toBeInTheDocument();
    }
    // The dot marks what the user holds, and only that.
    expect(screen.getByTestId("supported-models-configured-anthropic")).toBeInTheDocument();
    expect(screen.queryByTestId("supported-models-configured-openrouter")).toBeNull();
  });

  it("states a model's support as a set, and a mode's answer per mode", () => {
    open();
    // DeepSeek speaks a style all three harnesses speak — the case a single
    // "runs on" name per model could not express.
    const flash = cellsFor("deepseek-v4-flash");
    expect(flash.claude[0]).toHaveAttribute("data-runs", "yes");
    expect(flash.codex[0]).toHaveAttribute("data-runs", "yes");
    expect(flash.opencode[0]).toHaveAttribute("data-runs", "yes");

    // Anthropic's Opus appears in BOTH modes, and the answers differ: OpenCode
    // can carry an API key but never the subscription token (`carriers`). A
    // per-model answer that ignored the mode would state one of the two wrongly.
    const sub = within(screen.getByTestId("supported-models-mode-anthropic:sub"));
    const key = within(screen.getByTestId("supported-models-mode-anthropic:key"));
    expect(sub.getByTestId("supported-models-cell-claude-opus-5-opencode")).toHaveAttribute(
      "data-runs",
      "no",
    );
    expect(key.getByTestId("supported-models-cell-claude-opus-5-opencode")).toHaveAttribute(
      "data-runs",
      "yes",
    );
  });

  it("keeps the column of a harness this deployment did not install, and marks it", () => {
    open();
    // req 23 — dropping it would answer a different question than the one asked,
    // and a tick the user cannot act on must not read like one they can.
    const head = screen.getAllByTestId("supported-models-narrow-anthropic:key-opencode")[0];
    expect(head).toHaveTextContent(/not installed/);
    expect(
      screen.getAllByTestId("supported-models-narrow-anthropic:key-claude")[0],
    ).not.toHaveTextContent(/not installed/);
    // The row still carries OpenCode's real answer.
    expect(cellsFor("deepseek-v4-flash").opencode[0]).toHaveAttribute("data-runs", "yes");
  });

  it("says a harness runs a model but is absent, in words rather than by opacity alone", () => {
    open();
    // The answer is a glyph, so the same answer is sr-only TEXT — and it names
    // both sides, since the cell sits in a column away from the model name.
    expect(
      within(cellsFor("deepseek-v4-flash").opencode[0]).getByText(
        /OpenCode runs .*, but OpenCode is not installed here/,
      ),
    ).toBeInTheDocument();
  });

  it("marks nothing when the agent list has not arrived yet", () => {
    // Nothing known reads the same as "none installed" if the empty case is
    // drawn, and "not installed" on every column is a claim, not an absence.
    open({ agentList: [] });
    expect(
      screen.getAllByTestId("supported-models-narrow-anthropic:key-opencode")[0],
    ).not.toHaveTextContent(/not installed/);
  });

  it("narrows every service to one harness, and says which and how many", async () => {
    open();
    await userEvent.click(screen.getAllByTestId("supported-models-narrow-anthropic:sub-codex")[0]);

    const banner = screen.getByTestId("supported-models-narrowed");
    expect(banner).toHaveTextContent(/Showing only what\s*Codex\s*can run/);
    expect(banner).toHaveTextContent(/\d+ of \d+ rows/);

    // Codex cannot run Anthropic at all, so that service says so IN PLACE — a
    // section that vanished would read as a catalogue that had shrunk.
    expect(screen.getByTestId("supported-models-none-anthropic")).toHaveTextContent(
      "Nothing here for Codex.",
    );
    // …while OpenAI keeps its rows, and GLM (Claude-only) loses its own.
    expect(screen.getByTestId("supported-models-mode-openai:sub")).toBeInTheDocument();
    expect(screen.getByTestId("supported-models-none-zai")).toBeInTheDocument();
    // A row Codex cannot run is gone from a service that kept others: the
    // gateways carry both Anthropic-style and OpenAI-style models.
    expect(screen.queryByTestId("supported-models-row-vercel:key-anthropic/claude-opus-5")).toBeNull();
    expect(
      screen.getByTestId("supported-models-row-vercel:key-openai/gpt-5.6-sol"),
    ).toBeInTheDocument();
  });

  it("clears the narrowing from the same control that set it", async () => {
    open();
    const head = () => screen.getAllByTestId("supported-models-narrow-openai:sub-codex")[0];
    await userEvent.click(head());
    expect(screen.getByTestId("supported-models-narrowed")).toBeInTheDocument();

    await userEvent.click(head());
    expect(screen.queryByTestId("supported-models-narrowed")).toBeNull();
    expect(screen.queryByTestId("supported-models-none-anthropic")).toBeNull();
    expect(screen.getByTestId("supported-models-mode-anthropic:sub")).toBeInTheDocument();
  });

  it("clears the narrowing from the banner too", async () => {
    open();
    await userEvent.click(screen.getAllByTestId("supported-models-narrow-anthropic:sub-codex")[0]);
    await userEvent.click(screen.getByTestId("supported-models-clear"));
    expect(screen.queryByTestId("supported-models-narrowed")).toBeNull();
    expect(screen.getByTestId("supported-models-mode-anthropic:sub")).toBeInTheDocument();
  });

  it("can be narrowed to a harness this deployment does not have", async () => {
    // "What would this give me" is a fair question to ask before installing one,
    // so an absent harness is selectable rather than a dead column.
    open();
    await userEvent.click(screen.getAllByTestId("supported-models-narrow-deepseek:key-opencode")[0]);
    expect(screen.getByTestId("supported-models-narrowed")).toHaveTextContent(/OpenCode/);
    expect(screen.getByTestId("supported-models-mode-deepseek:key")).toBeInTheDocument();
    // OpenCode cannot carry Anthropic's subscription token, so that mode goes
    // while the key mode of the same service stays.
    expect(screen.queryByTestId("supported-models-mode-anthropic:sub")).toBeNull();
    expect(screen.getByTestId("supported-models-mode-anthropic:key")).toBeInTheDocument();
  });

  /**
   * The open-at-a-service scroll, asserted on the SCROLL and not on the section
   * existing.
   *
   * Written after the first version of this test passed over a dialog that never
   * scrolled at all: every section exists in the DOM whatever `initialServiceId`
   * says, so "the section is there" is true even when the feature is entirely
   * broken. jsdom lays nothing out, so the geometry is stubbed — the boxes are
   * what the component reads, and stubbing them is what makes the arithmetic
   * observable.
   */
  it("scrolls to the service it was opened at, and does not yank back afterwards", async () => {
    // jsdom lays nothing out, so both boxes read 0×0 and the component's
    // arithmetic is invisible. Stubbing the measurement is what makes it visible:
    // the pane's viewport starts at 0, DeepSeek's section sits 900px down it.
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const top =
        (this as HTMLElement).dataset?.testid === "supported-models-service-deepseek" ? 900 : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };
    try {
      open({ initialServiceId: "deepseek" });
      const pane = screen.getByTestId("supported-models-service-anthropic").parentElement!;
      expect(pane).toHaveClass("overflow-y-auto");
      // The defect this replaces: React attaches child refs before the parent's,
      // so measuring from the SECTION's callback found no pane and scrolled
      // nowhere — and every section exists in the DOM regardless, so a test that
      // asserted the section's presence passed over it.
      //
      // A real browser then clamps this to the pane's own maximum, which is why
      // opening at the LAST service lands it part-way down rather than at the top.
      // That is the scroll container's arithmetic, not this component's.
      expect(pane.scrollTop).toBe(900);

      // Narrowing re-renders, which re-attaches the inline ref callback. Without
      // the one-shot guard that would yank the pane back to DeepSeek, however far
      // the user had scrolled since.
      pane.scrollTop = 400;
      await userEvent.click(screen.getAllByTestId("supported-models-narrow-deepseek:key-claude")[0]);
      expect(pane.scrollTop).toBe(400);
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
  });

  it("shows a price and a context window per row", () => {
    open();
    const row = screen.getByTestId("supported-models-row-deepseek:key-deepseek-v4-flash");
    expect(row).toHaveTextContent("deepseek-v4-flash");
    expect(row).toHaveTextContent(/[0-9]+M|[0-9]+K/);
    expect(row).toHaveTextContent(/\$/);
  });
});
