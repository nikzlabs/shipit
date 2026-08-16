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

/**
 * One row's harness answers, **scoped to the `(service, mode)` the row is in**.
 *
 * The first version took a bare model id and read `getAllByTestId(...)[0]`, which
 * is how this suite came to pin nothing about the gateways: `deepseek-v4-flash`
 * is a row of DeepSeek, OpenRouter AND Vercel, and only the first was ever
 * inspected. Cross-backend review found that a `buildSupport` that skipped a
 * whole service — every OpenRouter row answering "no harness runs this" — shipped
 * green.
 */
function answers(modeKey: string, modelId: string): Record<string, string | null> {
  const table = within(screen.getByTestId(`supported-models-mode-${modeKey}`));
  const read = (harness: string) =>
    table.getByTestId(`supported-models-cell-${modelId}-${harness}`).getAttribute("data-runs");
  return { claude: read("claude"), codex: read("codex"), opencode: read("opencode") };
}

describe("SupportedModelsDialog", () => {
  afterEach(cleanup);

  it("lists every service in the catalogue, not only the configured ones", () => {
    // req 23's whole point: the question is asked BEFORE a credential exists, so
    // a service the user has never touched must still be here — and nothing on
    // this screen marks which ones the user holds, because that is the panel
    // behind it, and depending on it here would make a pre-credential surface
    // credential-dependent.
    open();
    for (const service of allServices()) {
      expect(screen.getByTestId(`supported-models-service-${service.id}`)).toBeInTheDocument();
    }
    // Every mode of every service, too — a service whose second mode went
    // missing would still pass the loop above.
    for (const service of allServices()) {
      for (const mode of service.modes) {
        expect(
          screen.getByTestId(`supported-models-mode-${service.id}:${mode.kind}`),
        ).toBeInTheDocument();
      }
    }
  });

  it("states a model's support as a set, and a mode's answer per mode", () => {
    open();
    // DeepSeek speaks a style all three harnesses speak — the case a single
    // "runs on" name per model could not express.
    expect(answers("deepseek:key", "deepseek-v4-flash")).toEqual({
      claude: "yes",
      codex: "yes",
      opencode: "yes",
    });

    // Anthropic's Opus appears in BOTH modes, and the answers differ: OpenCode
    // can carry an API key but never the subscription token (`carriers`). A
    // per-model answer that ignored the mode would state one of the two wrongly.
    expect(answers("anthropic:sub", "claude-opus-5").opencode).toBe("no");
    expect(answers("anthropic:key", "claude-opus-5").opencode).toBe("yes");
  });

  /**
   * **Every service gets its own assertion, because a per-service hole is
   * invisible otherwise.** Found by cross-backend review: with the answers read
   * off the first matching row, the gateways were pinned by nothing at all, and
   * `buildSupport` skipping a whole service passed the suite.
   *
   * The expected values are written out rather than derived — deriving them from
   * the same catalogue call the component makes would assert only that the
   * function equals itself.
   */
  it("answers per service, including both gateways", () => {
    open();
    // A gateway's answer follows the MODEL's style, not the gateway's: an
    // Anthropic-style row on OpenRouter reaches Claude Code and OpenCode, a
    // DeepSeek row reaches all three, and a GPT row reaches Codex and OpenCode.
    expect(answers("openrouter:key", "anthropic/claude-opus-5")).toEqual({
      claude: "yes",
      codex: "no",
      opencode: "yes",
    });
    expect(answers("openrouter:key", "deepseek/deepseek-v4-flash")).toEqual({
      claude: "yes",
      codex: "yes",
      opencode: "yes",
    });
    expect(answers("vercel:key", "openai/gpt-5.6-sol")).toEqual({
      claude: "no",
      codex: "yes",
      opencode: "yes",
    });
    expect(answers("vercel:key", "anthropic/claude-sonnet-5")).toEqual({
      claude: "yes",
      codex: "no",
      opencode: "yes",
    });
    // OpenAI's subscription is account-only and Codex's alone; GLM's plan token
    // is Claude Code's alone (`carriers`), while its API key also reaches
    // OpenCode.
    expect(answers("openai:sub", "gpt-5.6-sol")).toEqual({
      claude: "no",
      codex: "yes",
      opencode: "no",
    });
    expect(answers("zai:sub", "glm-5.2[1m]")).toEqual({
      claude: "yes",
      codex: "no",
      opencode: "no",
    });
    expect(answers("zai:key", "glm-5.2")).toEqual({
      claude: "yes",
      codex: "no",
      opencode: "yes",
    });
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
    expect(answers("deepseek:key", "deepseek-v4-flash").opencode).toBe("yes");
  });

  it("says a harness runs a model but is absent, in words rather than by opacity alone", () => {
    open();
    // The answer is a glyph, so the same answer is sr-only TEXT — and it names
    // both sides, since the cell sits in a column away from the model name.
    const cell = within(screen.getByTestId("supported-models-mode-deepseek:key")).getByTestId(
      "supported-models-cell-deepseek-v4-flash-opencode",
    );
    expect(within(cell).getByText(/OpenCode runs .*, but OpenCode is not installed here/))
      .toBeInTheDocument();
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
    // The count must agree with the rows the user can see. `/\d+ of \d+ rows/`
    // passed any two numbers, including a total that ignored the narrowing.
    const visible = screen.getAllByTestId(/^supported-models-row-/).length;
    const total = allServices().reduce(
      (n, s) => n + s.modes.reduce((m, mode) => m + mode.models.length, 0),
      0,
    );
    expect(visible).toBeLessThan(total);
    expect(banner).toHaveTextContent(`${visible} of ${total} rows`);

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

  it("shows the model's own window and rates, not merely a number and a dollar sign", () => {
    // Written against the figures rather than the shape: `/\$/` and
    // `/[0-9]+M|[0-9]+K/` passed a swapped input/output pair, a 1000x window
    // error, and another model's rates entirely (cross-backend review).
    open();
    const row = screen.getByTestId("supported-models-row-deepseek:key-deepseek-v4-flash");
    expect(row).toHaveTextContent("V4 Flash");
    expect(row).toHaveTextContent("deepseek-v4-flash");
    expect(row).toHaveTextContent("1M");
    // Input first, output second — the order the column head states.
    expect(row).toHaveTextContent("$0.14 / $0.28");

    // A 200K window is said as 200K, not 0.2M — the sub-million branch.
    expect(screen.getByTestId("supported-models-row-anthropic:sub-haiku")).toHaveTextContent("200K");
  });
});
