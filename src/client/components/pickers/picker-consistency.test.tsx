import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessSelector, ModelSelector } from "../ModelPicker.js";
import { ReasoningSelector } from "../ReasoningSelector.js";
import { ReviewerSection } from "../Settings/tabs/ReviewerSection.js";
import { BackgroundWorkSection } from "../Settings/BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { Picker, PickerOption, PICKER_TRIGGER_CLASS } from "./Picker.js";
import { ServiceSelector } from "./ServiceSelector.js";
import type { AgentOption } from "../../agent-types.js";
import type { ReviewerSlotView } from "../../../server/shared/types/agent-types.js";

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

function triggersOnEverySurface(): Record<string, HTMLButtonElement> {
  const found: Record<string, HTMLButtonElement> = {};

  render(
    <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
  );
  found["composer model"] = screen.getByTestId("model-trigger") as HTMLButtonElement;
  cleanup();

  render(<HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={() => {}} />);
  found["composer harness"] = screen.getByTestId("harness-trigger") as HTMLButtonElement;
  cleanup();

  render(
    <ReasoningSelector agent={agents[0]} sessionReasoning="high" onChange={() => {}} />,
  );
  found["composer reasoning"] = screen.getByTestId("reasoning-trigger") as HTMLButtonElement;
  cleanup();

  useSettingsStore.getState().setReviewers([reviewerSlot("first"), reviewerSlot("second")]);
  render(<ReviewerSection agentList={agents} />);
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

    expect(Object.keys(triggers)).toHaveLength(8);

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
    const { container: reviewer } = render(<ReviewerSection agentList={agents} />);
    expect(reviewer.querySelectorAll("select")).toHaveLength(0);
    cleanup();

    const { container: background } = render(<BackgroundWorkSection agentList={agents} />);
    expect(background.querySelectorAll("select")).toHaveLength(0);
  });

  /**
   * req 14 — a picker with nothing to pick is not rendered.
   *
   * `disabled` was the first attempt and it does not hold: the trigger below was
   * already disabled when this was written, and clicking it still opened an
   * empty menu, because Radix binds the trigger on `pointerdown`. So the
   * assertion is ABSENCE, not a disabled attribute — a test for the latter would
   * have passed against the reported bug.
   */
  it("renders no service control at all when there are no services", async () => {
    const user = userEvent.setup();
    render(
      <ServiceSelector services={[]} selected={undefined} onChange={() => {}} idPrefix="empty" />,
    );

    expect(screen.queryByTestId("empty-service-trigger")).toBeNull();

    expect(screen.queryByTestId("empty-service-menu")).toBeNull();
    await user.click(document.body);
    expect(screen.queryByTestId("empty-service-menu")).toBeNull();
  });

  it("renders nothing when its options are all absent", () => {

    const anyToShow = [].length > 0;
    render(
      <Picker label="Nothing" ariaLabel="Nothing" triggerTestId="nothing-trigger">
        {[].map(() => (
          <PickerOption key="x" label="x" onSelect={() => {}} />
        ))}
        {anyToShow && <PickerOption label="hidden" onSelect={() => {}} />}
        {null}
      </Picker>,
    );

    expect(screen.queryByTestId("nothing-trigger")).toBeNull();
  });

  it("shows no pickers on either Settings surface when nothing is runnable", () => {
    const none: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, hasRunnableModels: false, models: [], eligibleModels: [], supportsReview: true },
    ];
    useSettingsStore.getState().setReviewers([
      { slot: "first", source: "auto", resolved: undefined },
      { slot: "second", source: "auto", resolved: undefined },
    ]);
    const { container: reviewer } = render(<ReviewerSection agentList={none} />);
    expect(reviewer.querySelectorAll("button[aria-label^='Service for']")).toHaveLength(0);
    expect(reviewer.querySelectorAll("button[aria-label^='Model for']")).toHaveLength(0);

    expect(screen.getAllByText(/Nothing to review with yet/)).toHaveLength(2);
    cleanup();

    const { container: background } = render(<BackgroundWorkSection agentList={none} />);
    expect(background.querySelectorAll("button[aria-label^='Service for']")).toHaveLength(0);
    expect(background.querySelectorAll("button[aria-label='Model for background work']")).toHaveLength(0);
    expect(screen.getByText(/Nothing to run it on yet/)).toBeTruthy();
  });
});
