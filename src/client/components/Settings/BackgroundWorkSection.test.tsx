import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { AgentOption } from "../../agent-types.js";

/**
 * docs/252 phase 7 (req 9) — the setting has to be VISIBLE, and its unset state
 * has to read as "follows the install" rather than as an empty control. That is
 * the whole reason a default is acceptable here where a hidden dependency is
 * not: the user can see what background work runs on and change it.
 *
 * docs/261 phase 6 (reqs 11, 12, 13) — the control changed from a native
 * `<select>` to the shared `Picker`, with the service ahead of the model. Every
 * assertion below is the same requirement, asked of the new control.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-v4-flash", "deepseek-v4"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
        canonicalModelKey: "deepseek-v4-flash",
      },
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4",
        label: "V4",
        canonicalModelKey: "deepseek-v4",
      },
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
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-v4-flash"],
    // The SAME triple on a second installed harness. The harness is derived
    // (req 9), so this must not become a second row the user picks between.
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
        canonicalModelKey: "deepseek-v4-flash",
      },
    ],
    supportsReview: true,
  },
];

const RESOLVED_FLASH = {
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-v4-flash",
  serviceName: "DeepSeek",
  label: "V4 Flash",
  harnessId: "claude",
  source: "default" as const,
};

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): { nonTurnModel: unknown } {
  const args = fetchMock.mock.calls[call] as unknown as [string, { body: string }];
  return JSON.parse(args[1].body) as { nonTurnModel: unknown };
}

beforeEach(() => {
  useSettingsStore.getState().setNonTurnModel(null, null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BackgroundWorkSection", () => {
  it("labels the unset state with what it currently resolves to", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    const fallback = screen.getByTestId("background-work-model-default");
    expect(fallback.textContent).toContain("ShipIt's default");
    // The unset state names what it follows rather than reading as a blank —
    // which is what stops the default from re-creating the hidden dependency
    // req 9 exists to remove.
    expect(fallback.textContent).toContain("DeepSeek");
    expect(fallback.textContent).toContain("V4 Flash");
  });

  // The derivation is stated as a fact, never offered as a control.
  it("shows the derived harness without offering a choice of harness", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);

    expect(screen.getByText(/runs on Claude Code/)).toBeTruthy();
    expect(screen.queryByTestId("harness-trigger")).toBeNull();
    // One model offered on two installed harnesses is ONE option, not two.
    await user.click(screen.getByTestId("background-work-model"));
    expect(screen.getAllByTestId("background-work-model-option-deepseek-v4-flash")).toHaveLength(1);
  });

  /**
   * docs/261 req 11 — the service is a control carrying its billing mode, not a
   * line of prose. A user asking "is this my subscription or my card" answers it
   * on the row they are about to click.
   */
  it("offers the service as its own control, with its billing mode on the row", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-service-trigger"));

    expect(screen.getByTestId("background-work-service-option-deepseek:key").textContent)
      .toContain("API key");
    expect(screen.getByTestId("background-work-service-option-anthropic:sub").textContent)
      .toContain("Subscription");
  });

  /** docs/261 req 12 — the model list is bounded by the chosen service. */
  it("lists only the chosen service's models", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.getByTestId("background-work-model-option-deepseek-v4-flash")).toBeTruthy();
    expect(screen.getByTestId("background-work-model-option-deepseek-v4")).toBeTruthy();
    expect(screen.queryByTestId("background-work-model-option-claude-opus-5")).toBeNull();
  });

  it("sends the whole triple when the user pins a model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nonTurnModel: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));

    expect(fetchMock).toHaveBeenCalledOnce();
    // A bare model id could not say which service or mode is billed (req 5).
    expect(bodyOf(fetchMock).nonTurnModel).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4",
    });
  });

  /**
   * docs/261 phase 6 — changing the service is a pin like any other, and it
   * carries a model, because a slot with a service and no model is not a
   * setting anything can run.
   */
  it("pins the new service's first model when the service changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    expect(bodyOf(fetchMock).nonTurnModel).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
  });

  it("clears the pin when the user picks the default", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-default"));

    expect(bodyOf(fetchMock).nonTurnModel).toBeNull();
  });

  // Cross-backend review: a pin the install can no longer run is not among the
  // eligible choices, so the control read as the DEFAULT — while the server
  // still held the pin and failed it on every session. The two have to agree,
  // and the honest way is to name the pin the server is actually holding.
  it("names a stale pin instead of silently reading as the default", () => {
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
      null,
    );

    render(<BackgroundWorkSection agentList={agents} />);

    expect((screen.getByTestId("background-work-model") as HTMLButtonElement).textContent)
      .toContain("gpt-5.4-mini");
    expect((screen.getByTestId("background-work-service-trigger") as HTMLButtonElement).textContent)
      .toContain("openai");
    expect(screen.getByText(/no longer available/)).toBeTruthy();
  });
});
