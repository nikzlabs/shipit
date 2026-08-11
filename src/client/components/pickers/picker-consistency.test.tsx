import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ModelSelector } from "../ModelPicker.js";
import { ReasoningSelector } from "../ReasoningSelector.js";
import { ReviewerTab } from "../Settings/tabs/ReviewerTab.js";
import { BackgroundWorkSection } from "../Settings/BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { PICKER_TRIGGER_CLASS } from "./Picker.js";
import type { AgentOption } from "../../agent-types.js";
import type { ReviewerSlotView } from "../../../server/shared/types/agent-types.js";

/**
 * docs/261 req 13 — **the same control everywhere**, asserted rather than
 * asserted-in-a-docstring.
 *
 * The three surfaces drifted apart once already: the composer had a borderless
 * trigger, the Reviewer tab grew its own bordered one, and Background work used
 * a native `<select>` that matched neither. Each was locally reasonable, and
 * nothing failed when they diverged.
 *
 * So this compares what a user actually sees — the rendered `className` of each
 * trigger — rather than checking that `Picker.js` is imported. An import can be
 * present and the class overridden at the call site, which is precisely how a
 * shared component stops being shared.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-opus-5"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
    ],
    supportsReview: true,
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
  },
];

const reviewerSlot = (slot: "first" | "second"): ReviewerSlotView => ({
  slot,
  source: "auto",
  resolved: {
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    serviceName: "Anthropic",
    label: "Opus 5",
    harnessId: "claude",
    harnessName: "Claude Code",
    reasoningEffort: "high",
    reasoningLabel: "High",
  },
});

/** Every trigger a user can meet, by the surface that renders it. */
function triggersOnEverySurface(): Record<string, HTMLButtonElement> {
  const found: Record<string, HTMLButtonElement> = {};

  render(
    <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
  );
  found["composer model"] = screen.getByTestId("model-trigger") as HTMLButtonElement;
  cleanup();

  render(
    <ReasoningSelector agent={agents[0]} sessionReasoning="high" onChange={() => {}} />,
  );
  found["composer reasoning"] = screen.getByTestId("reasoning-trigger") as HTMLButtonElement;
  cleanup();

  useSettingsStore.getState().setReviewers([reviewerSlot("first"), reviewerSlot("second")]);
  render(<ReviewerTab agentList={agents} />);
  found["reviewer service"] = screen.getByTestId("reviewer-first-service-trigger") as HTMLButtonElement;
  found["reviewer model"] = screen.getByTestId("reviewer-model-trigger-first") as HTMLButtonElement;
  found["reviewer reasoning"] = screen.getByTestId("reviewer-reasoning-trigger-first") as HTMLButtonElement;
  cleanup();

  useSettingsStore.getState().setNonTurnModel(null, {
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    serviceName: "Anthropic",
    label: "Opus 5",
    harnessId: "claude",
    source: "default",
  });
  render(<BackgroundWorkSection agentList={agents} />);
  found["background service"] = screen.getByTestId("background-work-service-trigger") as HTMLButtonElement;
  found["background model"] = screen.getByTestId("background-work-model") as HTMLButtonElement;
  cleanup();

  return found;
}

beforeEach(() => {
  useSettingsStore.getState().setReviewers([]);
  useSettingsStore.getState().setNonTurnModel(null, null);
});

describe("picker consistency (req 13)", () => {
  it("renders one trigger, on every surface that asks the user to choose", () => {
    const triggers = triggersOnEverySurface();
    // Guards the guard: if a surface stops rendering its control, the loop
    // below would pass by asserting nothing.
    expect(Object.keys(triggers)).toHaveLength(7);

    for (const [where, button] of Object.entries(triggers)) {
      expect(`${where}: ${button.className}`).toBe(
        `${where}: ${PICKER_TRIGGER_CLASS} hover:bg-(--color-bg-hover) cursor-pointer`,
      );
    }
  });

  /**
   * Settings must not reach for a native control again. `<select>` was the one
   * Background work shipped with, and it is the shape most likely to come back
   * — it is fewer lines than a menu, and it looks like nothing else here.
   */
  it("uses no native select on either Settings surface", () => {
    useSettingsStore.getState().setReviewers([reviewerSlot("first"), reviewerSlot("second")]);
    const { container: reviewer } = render(<ReviewerTab agentList={agents} />);
    expect(reviewer.querySelectorAll("select")).toHaveLength(0);
    cleanup();

    const { container: background } = render(<BackgroundWorkSection agentList={agents} />);
    expect(background.querySelectorAll("select")).toHaveLength(0);
  });
});
